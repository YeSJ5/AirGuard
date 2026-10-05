import os
from PIL import Image, ImageDraw

def create_airguard_favicon():
    sizes = [(16, 16), (32, 32), (48, 48), (64, 64)]
    images = []
    
    for width, height in sizes:
        # Create base image with anti-aliasing scaling
        scale = 4
        s_w, s_h = width * scale, height * scale
        img = Image.new("RGBA", (s_w, s_h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        
        # 1. Dark Rounded Badge Background (#070d18)
        margin = int(2 * scale)
        r = int(6 * scale)
        draw.rounded_rectangle(
            [(margin, margin), (s_w - margin, s_h - margin)],
            radius=r,
            fill=(7, 13, 24, 255),
            outline=(30, 41, 59, 255),
            width=int(1.5 * scale)
        )
        
        # 2. Outer Signal Ring (#0284c7)
        cx, cy = s_w // 2, s_h // 2
        ring_r = int(s_w * 0.36)
        draw.ellipse(
            [(cx - ring_r, cy - ring_r), (cx + ring_r, cy + ring_r)],
            outline=(2, 132, 199, 120),
            width=int(1.5 * scale)
        )
        
        # 3. Dynamic Radar Sweep Arc (#38bdf8 to #10b981)
        draw.arc(
            [(cx - ring_r, cy - ring_r), (cx + ring_r, cy + ring_r)],
            start=270,
            end=360,
            fill=(56, 189, 248, 255),
            width=int(2.5 * scale)
        )
        
        # 4. Stylized Supersonic Aircraft Silhouette
        # Coordinates scaled relative to canvas size
        points = [
            (cx, cy - int(ring_r * 0.75)),               # Nose
            (cx + int(ring_r * 0.18), cy - int(ring_r * 0.25)),
            (cx + int(ring_r * 0.75), cy + int(ring_r * 0.05)),  # Right wing tip
            (cx + int(ring_r * 0.75), cy + int(ring_r * 0.18)),
            (cx + int(ring_r * 0.18), cy + int(ring_r * 0.05)),  # Right root
            (cx + int(ring_r * 0.18), cy + int(ring_r * 0.50)),
            (cx + int(ring_r * 0.38), cy + int(ring_r * 0.65)),  # Right tail
            (cx + int(ring_r * 0.38), cy + int(ring_r * 0.75)),
            (cx, cy + int(ring_r * 0.68)),               # Tail center
            (cx - int(ring_r * 0.38), cy + int(ring_r * 0.75)),
            (cx - int(ring_r * 0.38), cy + int(ring_r * 0.65)),  # Left tail
            (cx - int(ring_r * 0.18), cy + int(ring_r * 0.50)),
            (cx - int(ring_r * 0.18), cy + int(ring_r * 0.05)),  # Left root
            (cx - int(ring_r * 0.75), cy + int(ring_r * 0.18)),
            (cx - int(ring_r * 0.75), cy + int(ring_r * 0.05)),  # Left wing tip
            (cx - int(ring_r * 0.18), cy - int(ring_r * 0.25)),
        ]
        draw.polygon(points, fill=(255, 255, 255, 255), outline=(2, 132, 199, 255))
        
        # 5. Trust Verification Signal Beacon Dot (#10b981)
        beacon_r = int(1.8 * scale)
        beacon_y = cy - int(ring_r * 0.75)
        draw.ellipse(
            [(cx - beacon_r, beacon_y - beacon_r), (cx + beacon_r, beacon_y + beacon_r)],
            fill=(16, 185, 129, 255)
        )
        
        # Downsample with high-quality Lanczos filter
        resized = img.resize((width, height), Image.Resampling.LANCZOS)
        images.append(resized)

    # Save as multi-resolution ICO
    ico_path = 'f:/major_project/frontend/public/favicon.ico'
    images[0].save(ico_path, format="ICO", sizes=sizes, append_images=images[1:])
    print(f"Generated multi-resolution ICO at {ico_path} with sizes: {sizes}")

if __name__ == '__main__':
    create_airguard_favicon()
