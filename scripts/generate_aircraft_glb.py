"""
generate_aircraft_glb.py
Generates a sleek, low-poly commercial passenger aircraft 3D model in glTF 2.0 binary (.glb) format.
Dimensions are realistic (~36m length, ~34m wingspan).
Optimized for high-performance WebGL rendering in Cesium.
"""

import json
import math
import struct
from pathlib import Path


def create_aircraft_glb(output_path: str):
    # Buffers to collect vertex attributes and indices
    # We will build distinct primitives for:
    # 0: Fuselage (White)
    # 1: Wings & Stabilizers (Aero Light Gray)
    # 2: Cockpit Windshield (Dark Gloss / Blue-Black)
    # 3: Engines & Pylons (Turbine Titanium Gray)

    class PrimitiveBuilder:
        def __init__(self):
            self.positions = []  # list of (x, y, z)
            self.normals = []    # list of (nx, ny, nz)
            self.indices = []    # list of int

        def add_triangle(self, p1, p2, p3, n1=None, n2=None, n3=None):
            if n1 is None:
                # Compute flat normal
                ax, ay, az = p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]
                bx, by, bz = p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]
                nx = ay * bz - az * by
                ny = az * bx - ax * bz
                nz = ax * by - ay * bx
                l = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                n1 = n2 = n3 = (nx / l, ny / l, nz / l)

            idx_base = len(self.positions)
            self.positions.extend([p1, p2, p3])
            self.normals.extend([n1, n2, n3])
            self.indices.extend([idx_base, idx_base + 1, idx_base + 2])

        def add_quad(self, p1, p2, p3, p4, n1=None, n2=None, n3=None, n4=None):
            # p1, p2, p3, p4 counter-clockwise
            self.add_triangle(p1, p2, p3, n1, n2, n3)
            self.add_triangle(p1, p3, p4, n1, n3, n4)

    fuselage = PrimitiveBuilder()
    wings = PrimitiveBuilder()
    cockpit = PrimitiveBuilder()
    engines = PrimitiveBuilder()

    # ----------------------------------------------------
    # 1. Fuselage
    # ----------------------------------------------------
    rings = [
        # (z, radius, center_y)
        (-18.0, 0.05, 0.0),    # Radome nose tip
        (-16.8, 0.70, -0.05),  # Nose curve front
        (-15.2, 1.40, 0.0),    # Forward nose
        (-13.5, 1.85, 0.05),   # Cockpit aft / forward cabin
        (-8.0,  1.90, 0.05),   # Front cabin
        (0.0,   1.90, 0.05),   # Mid cabin (wing junction)
        (8.0,   1.90, 0.05),   # Rear cabin
        (13.0,  1.65, 0.20),   # Tail taper start
        (16.0,  1.05, 0.50),   # Tail mid
        (18.2,  0.40, 0.75),   # Tail tip APU
        (18.8,  0.10, 0.85),   # APU exhaust cone
    ]

    segments = 16
    ring_points = []
    ring_normals = []

    for z, r, cy in rings:
        pts = []
        nrms = []
        for i in range(segments):
            angle = 2.0 * math.pi * i / segments
            # glTF: +X is right, +Y is up, -Z is forward
            x = r * math.sin(angle)
            y = cy + r * math.cos(angle)
            pts.append((x, y, z))
            # Approximate normal outward
            nx = math.sin(angle)
            ny = math.cos(angle)
            nz = 0.0
            nrms.append((nx, ny, nz))
        ring_points.append(pts)
        ring_normals.append(nrms)

    for r_idx in range(len(rings) - 1):
        for i in range(segments):
            i_next = (i + 1) % segments
            p1 = ring_points[r_idx][i]
            p2 = ring_points[r_idx][i_next]
            p3 = ring_points[r_idx + 1][i_next]
            p4 = ring_points[r_idx + 1][i]

            n1 = ring_normals[r_idx][i]
            n2 = ring_normals[r_idx][i_next]
            n3 = ring_normals[r_idx + 1][i_next]
            n4 = ring_normals[r_idx + 1][i]

            fuselage.add_quad(p1, p2, p3, p4, n1, n2, n3, n4)

    # ----------------------------------------------------
    # 2. Cockpit Windshield (Sleek dark visor)
    # ----------------------------------------------------
    # Curved windshield around front nose
    cw_pts = [
        # Center-left, left-corner, right-corner, center-right
        # Lower row
        (-0.75, 0.50, -15.4),
        (-1.20, 0.35, -14.6),
        (1.20,  0.35, -14.6),
        (0.75,  0.50, -15.4),
        # Upper row
        (-0.65, 0.95, -15.0),
        (-1.05, 0.80, -14.3),
        (1.05,  0.80, -14.3),
        (0.65,  0.95, -15.0),
    ]
    # Center windows
    cockpit.add_quad(cw_pts[0], cw_pts[3], cw_pts[7], cw_pts[4])
    # Left window
    cockpit.add_quad(cw_pts[1], cw_pts[0], cw_pts[4], cw_pts[5])
    # Right window
    cockpit.add_quad(cw_pts[3], cw_pts[2], cw_pts[6], cw_pts[7])

    # ----------------------------------------------------
    # 3. Main Wings & Winglets (Symmetric)
    # ----------------------------------------------------
    def build_wing(side=1.0):
        # side = 1.0 for right wing (+X), -1.0 for left wing (-X)
        # Low swept wing profile: root -> mid -> tip
        # Root section (adjacent to fuselage)
        r_le = (1.8 * side, -0.2, -1.8)  # root leading edge
        r_te = (1.8 * side, -0.4, 4.2)   # root trailing edge
        r_top = (1.8 * side, 0.05, 0.8)  # root upper thickest point
        r_bot = (1.8 * side, -0.5, 0.8)  # root lower

        # Mid section
        m_le = (9.0 * side, 0.1, 0.6)
        m_te = (9.0 * side, 0.0, 4.6)
        m_top = (9.0 * side, 0.25, 2.4)
        m_bot = (9.0 * side, -0.15, 2.4)

        # Tip section
        t_le = (16.8 * side, 0.6, 3.6)
        t_te = (16.8 * side, 0.5, 5.6)
        t_top = (16.8 * side, 0.72, 4.4)
        t_bot = (16.8 * side, 0.48, 4.4)

        # Winglet tip
        w_le = (17.2 * side, 2.2, 4.5)
        w_te = (17.2 * side, 2.0, 6.0)

        # Inner wing upper panels
        if side > 0:
            wings.add_quad(r_le, m_le, m_top, r_top)
            wings.add_quad(r_top, m_top, m_te, r_te)
            # Inner wing lower panels
            wings.add_quad(r_bot, m_bot, m_le, r_le)
            wings.add_quad(r_te, m_te, m_bot, r_bot)

            # Outer wing upper panels
            wings.add_quad(m_le, t_le, t_top, m_top)
            wings.add_quad(m_top, t_top, t_te, m_te)
            # Outer wing lower panels
            wings.add_quad(m_bot, t_bot, t_le, m_le)
            wings.add_quad(m_te, t_te, t_bot, m_bot)

            # Winglet (canted up)
            wings.add_quad(t_le, w_le, w_te, t_te)
            wings.add_quad(t_te, w_te, w_le, t_le)
        else:
            # Reverse winding for opposite side
            wings.add_quad(m_le, r_le, r_top, m_top)
            wings.add_quad(m_top, r_top, r_te, m_te)
            wings.add_quad(m_bot, r_bot, r_le, m_le)
            wings.add_quad(m_te, r_te, r_bot, m_bot)

            wings.add_quad(t_le, m_le, m_top, t_top)
            wings.add_quad(t_top, m_top, m_te, t_te)
            wings.add_quad(t_bot, m_bot, m_le, t_le)
            wings.add_quad(t_te, m_te, m_bot, t_bot)

            wings.add_quad(w_le, t_le, t_te, w_te)
            wings.add_quad(w_te, t_te, t_le, w_le)

    build_wing(side=1.0)
    build_wing(side=-1.0)

    # ----------------------------------------------------
    # 4. Vertical Stabilizer (Fin & Rudder)
    # ----------------------------------------------------
    # Fin base on upper rear fuselage
    f_root_le = (0.0, 1.6, 9.5)
    f_root_te = (0.0, 1.8, 16.8)
    f_tip_le = (0.0, 7.4, 15.0)
    f_tip_te = (0.0, 7.1, 17.6)

    # Left and right side offset to give thickness
    thick_root = 0.25
    thick_tip = 0.08

    v_r_le_l = (-thick_root, f_root_le[1], f_root_le[2])
    v_r_le_r = ( thick_root, f_root_le[1], f_root_le[2])
    v_r_te_l = (-thick_root, f_root_te[1], f_root_te[2])
    v_r_te_r = ( thick_root, f_root_te[1], f_root_te[2])

    v_t_le_l = (-thick_tip, f_tip_le[1], f_tip_le[2])
    v_t_le_r = ( thick_tip, f_tip_le[1], f_tip_le[2])
    v_t_te_l = (-thick_tip, f_tip_te[1], f_tip_te[2])
    v_t_te_r = ( thick_tip, f_tip_te[1], f_tip_te[2])

    # Left face
    wings.add_quad(v_r_le_l, v_t_le_l, v_t_te_l, v_r_te_l)
    # Right face
    wings.add_quad(v_r_le_r, v_r_te_r, v_t_te_r, v_t_le_r)
    # Leading edge cap
    wings.add_quad(v_r_le_l, v_r_le_r, v_t_le_r, v_t_le_l)
    # Trailing edge cap
    wings.add_quad(v_r_te_l, v_t_te_l, v_t_te_r, v_r_te_r)
    # Tip top cap
    wings.add_quad(v_t_le_l, v_t_le_r, v_t_te_r, v_t_te_l)

    # ----------------------------------------------------
    # 5. Horizontal Tail Stabilizers (Swept)
    # ----------------------------------------------------
    def build_h_tail(side=1.0):
        ht_r_le = (0.6 * side, 0.8, 14.0)
        ht_r_te = (0.6 * side, 0.8, 17.0)
        ht_t_le = (6.2 * side, 1.1, 16.5)
        ht_t_te = (6.2 * side, 1.1, 18.0)

        # Upper and lower
        if side > 0:
            wings.add_quad(ht_r_le, ht_t_le, ht_t_te, ht_r_te)
            wings.add_quad(ht_r_te, ht_t_te, ht_t_le, ht_r_le)
        else:
            wings.add_quad(ht_t_le, ht_r_le, ht_r_te, ht_t_te)
            wings.add_quad(ht_t_te, ht_r_te, ht_r_le, ht_t_le)

    build_h_tail(side=1.0)
    build_h_tail(side=-1.0)

    # ----------------------------------------------------
    # 6. Twin Turbofan Engines & Underwing Pylons
    # ----------------------------------------------------
    def build_engine(engine_x):
        center_y = -1.15
        center_z = -0.4
        length = 4.2
        front_z = center_z - length * 0.55
        back_z = center_z + length * 0.45
        radius = 0.85
        eng_segs = 12

        # Pylon connecting nacelle to wing
        p_top_f = (engine_x, -0.15, center_z - 0.5)
        p_top_b = (engine_x, -0.05, center_z + 1.2)
        p_bot_f = (engine_x, center_y + radius * 0.85, center_z - 0.5)
        p_bot_b = (engine_x, center_y + radius * 0.85, center_z + 1.2)

        thick_p = 0.08
        p1 = (engine_x - thick_p, p_top_f[1], p_top_f[2])
        p2 = (engine_x + thick_p, p_top_f[1], p_top_f[2])
        p3 = (engine_x + thick_p, p_top_b[1], p_top_b[2])
        p4 = (engine_x - thick_p, p_top_b[1], p_top_b[2])

        p5 = (engine_x - thick_p, p_bot_f[1], p_bot_f[2])
        p6 = (engine_x + thick_p, p_bot_f[1], p_bot_f[2])
        p7 = (engine_x + thick_p, p_bot_b[1], p_bot_b[2])
        p8 = (engine_x - thick_p, p_bot_b[1], p_bot_b[2])

        engines.add_quad(p1, p4, p8, p5)
        engines.add_quad(p2, p6, p7, p3)
        engines.add_quad(p1, p5, p6, p2)
        engines.add_quad(p4, p3, p7, p8)

        # Nacelle cylinder
        front_pts = []
        back_pts = []
        nacelle_normals = []
        for i in range(eng_segs):
            ang = 2.0 * math.pi * i / eng_segs
            nx = math.sin(ang)
            ny = math.cos(ang)
            px = engine_x + radius * nx
            py = center_y + radius * ny
            front_pts.append((px, py, front_z))
            back_pts.append((px, py, back_z))
            nacelle_normals.append((nx, ny, 0.0))

        for i in range(eng_segs):
            i_next = (i + 1) % eng_segs
            n1 = nacelle_normals[i]
            n2 = nacelle_normals[i_next]
            engines.add_quad(front_pts[i], front_pts[i_next], back_pts[i_next], back_pts[i], n1, n2, n2, n1)

        # Front intake spinner cone & back exhaust cone
        spinner_tip = (engine_x, center_y, front_z + 0.3)
        exhaust_cone = (engine_x, center_y, back_z + 0.5)
        for i in range(eng_segs):
            i_next = (i + 1) % eng_segs
            # Intake disc
            engines.add_triangle(front_pts[i_next], front_pts[i], spinner_tip)
            # Exhaust cone
            engines.add_triangle(back_pts[i], back_pts[i_next], exhaust_cone)

    build_engine(engine_x=5.2)
    build_engine(engine_x=-5.2)

    # ----------------------------------------------------
    # Assemble glTF binary buffers
    # ----------------------------------------------------
    builders = [fuselage, wings, cockpit, engines]

    binary_data = bytearray()
    buffer_views = []
    accessors = []
    primitives = []

    # Material definitions
    materials = [
        {
            "name": "FuselageWhite",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.96, 0.97, 0.99, 1.0],
                "metallicFactor": 0.05,
                "roughnessFactor": 0.25,
            }
        },
        {
            "name": "AeroGray",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.82, 0.85, 0.89, 1.0],
                "metallicFactor": 0.15,
                "roughnessFactor": 0.40,
            }
        },
        {
            "name": "CockpitVisorDark",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.06, 0.10, 0.16, 1.0],
                "metallicFactor": 0.85,
                "roughnessFactor": 0.10,
            }
        },
        {
            "name": "TurbineTitanium",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.38, 0.41, 0.45, 1.0],
                "metallicFactor": 0.70,
                "roughnessFactor": 0.30,
            }
        }
    ]

    for mat_idx, bld in enumerate(builders):
        if not bld.positions:
            continue

        # Position data (VEC3 FLOAT)
        pos_bytes = bytearray()
        min_pos = [float("inf")] * 3
        max_pos = [float("-inf")] * 3
        for p in bld.positions:
            for c in range(3):
                min_pos[c] = min(min_pos[c], p[c])
                max_pos[c] = max(max_pos[c], p[c])
            pos_bytes.extend(struct.pack("<3f", *p))

        # Normal data (VEC3 FLOAT)
        norm_bytes = bytearray()
        for n in bld.normals:
            norm_bytes.extend(struct.pack("<3f", *n))

        # Index data (SCALAR UNSIGNED_INT)
        idx_bytes = bytearray()
        for idx in bld.indices:
            idx_bytes.extend(struct.pack("<I", idx))

        # Align current buffer offset to 4 bytes
        def align_4(b_array):
            while len(b_array) % 4 != 0:
                b_array.append(0)

        # 1. Position bufferView & accessor
        align_4(binary_data)
        pos_offset = len(binary_data)
        binary_data.extend(pos_bytes)
        bv_pos_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": pos_offset,
            "byteLength": len(pos_bytes),
            "target": 34962  # ARRAY_BUFFER
        })
        acc_pos_idx = len(accessors)
        accessors.append({
            "bufferView": bv_pos_idx,
            "byteOffset": 0,
            "componentType": 5126,  # FLOAT
            "count": len(bld.positions),
            "type": "VEC3",
            "min": min_pos,
            "max": max_pos
        })

        # 2. Normal bufferView & accessor
        align_4(binary_data)
        norm_offset = len(binary_data)
        binary_data.extend(norm_bytes)
        bv_norm_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": norm_offset,
            "byteLength": len(norm_bytes),
            "target": 34962  # ARRAY_BUFFER
        })
        acc_norm_idx = len(accessors)
        accessors.append({
            "bufferView": bv_norm_idx,
            "byteOffset": 0,
            "componentType": 5126,  # FLOAT
            "count": len(bld.normals),
            "type": "VEC3"
        })

        # 3. Index bufferView & accessor
        align_4(binary_data)
        idx_offset = len(binary_data)
        binary_data.extend(idx_bytes)
        bv_idx_idx = len(buffer_views)
        buffer_views.append({
            "buffer": 0,
            "byteOffset": idx_offset,
            "byteLength": len(idx_bytes),
            "target": 34963  # ELEMENT_ARRAY_BUFFER
        })
        acc_idx_idx = len(accessors)
        accessors.append({
            "bufferView": bv_idx_idx,
            "byteOffset": 0,
            "componentType": 5125,  # UNSIGNED_INT
            "count": len(bld.indices),
            "type": "SCALAR"
        })

        primitives.append({
            "attributes": {
                "POSITION": acc_pos_idx,
                "NORMAL": acc_norm_idx
            },
            "indices": acc_idx_idx,
            "material": mat_idx
        })

    # Ensure binary buffer total size is 4-byte aligned
    while len(binary_data) % 4 != 0:
        binary_data.append(0)

    gltf_dict = {
        "asset": {
            "version": "2.0",
            "generator": "AirGuard 3D Model Synthesizer"
        },
        "scene": 0,
        "scenes": [
            {"name": "AircraftScene", "nodes": [0]}
        ],
        "nodes": [
            {"name": "CommercialAirliner", "mesh": 0}
        ],
        "meshes": [
            {
                "name": "CommercialAirlinerMesh",
                "primitives": primitives
            }
        ],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [
            {
                "byteLength": len(binary_data)
            }
        ]
    }

    json_str = json.dumps(gltf_dict, separators=(',', ':'))
    json_bytes = json_str.encode('utf-8')
    # Pad json_bytes to 4-byte alignment with space (0x20) per glTF spec
    while len(json_bytes) % 4 != 0:
        json_bytes += b' '

    # GLB Header (12 bytes)
    magic = 0x46546C67  # 'glTF'
    version = 2
    total_length = 12 + 8 + len(json_bytes) + 8 + len(binary_data)

    glb = bytearray()
    glb.extend(struct.pack("<3I", magic, version, total_length))

    # Chunk 0: JSON (8 bytes header + json_bytes)
    chunk0_type = 0x4E4F534A  # 'JSON'
    glb.extend(struct.pack("<2I", len(json_bytes), chunk0_type))
    glb.extend(json_bytes)

    # Chunk 1: BIN (8 bytes header + binary_data)
    chunk1_type = 0x004E4942  # 'BIN\0'
    glb.extend(struct.pack("<2I", len(binary_data), chunk1_type))
    glb.extend(binary_data)

    out_file = Path(output_path)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, "wb") as f:
        f.write(glb)

    print(f"Generated aircraft model successfully: {out_file} ({len(glb)} bytes)")


if __name__ == "__main__":
    create_aircraft_glb("f:/major_project/frontend/public/models/aircraft.glb")
