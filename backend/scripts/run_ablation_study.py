import asyncio
import os
import sys
from typing import Dict, Any, List, Tuple
import numpy as np
import torch
from datetime import datetime, timezone
from sklearn.model_selection import train_test_split
from sklearn.metrics import precision_recall_fscore_support, confusion_matrix

# Add backend directory to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.core.database import async_session_maker
from app.models import ModelRun
from app.detection.ensemble import TrustScoringEnsemble
from app.detection.autoencoder import (
    UnsupervisedAutoencoder,
    combine_scores,
    MODEL_PATH as AE_MODEL_PATH
)


def generate_ablation_dataset(n_samples_per_class: int = 1000) -> Tuple[np.ndarray, np.ndarray, List[float]]:
    """Generates synthetic training and held-out evaluation datasets.
    
    Includes clean flights, turbulent benign edge cases, and 5 distinct threat injections.
    Returns:
        X: feature matrix of shape (2000, 9)
        y: ground truth labels (0 = normal, 1 = anomaly)
        trilateration_scores: geometric plausibility scores for each sample
    """
    np.random.seed(42)

    # --- Negative Class (Normal Flights with Realistic Atmospheric Edge Cases) ---
    neg_features = []
    neg_trilateration = []

    # 1. Clean flights (85%)
    n_clean = int(n_samples_per_class * 0.85)
    for _ in range(n_clean):
        speed_var = np.random.exponential(scale=2.0)
        heading_var = np.random.exponential(scale=5.0)
        alt_rate_var = np.random.exponential(scale=0.5)
        time_diff = np.random.normal(loc=8.0, scale=0.5)
        rule_flags = [0.0, 0.0, 0.0, 0.0, 0.0]
        neg_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)
        neg_trilateration.append(1.0) # fully consistent receivers

    # 2. Benign edge cases (15%): Turbulent air, severe weather gusts, polling jitter
    n_turbulent = n_samples_per_class - n_clean
    for _ in range(n_turbulent):
        speed_var = np.random.exponential(scale=18.0) # gust turbulence
        heading_var = np.random.exponential(scale=14.0) # wind drift
        alt_rate_var = np.random.exponential(scale=8.0) # updraft / downdraft variance
        time_diff = np.random.normal(loc=9.5, scale=1.5)
        # Normal flights do not violate physical rules
        rule_flags = [0.0, 0.0, 0.0, 0.0, 0.0]
        neg_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)
        neg_trilateration.append(1.0)

    X_neg = np.array(neg_features)
    y_neg = np.zeros(n_samples_per_class)

    # --- Positive Class: 5 Injected Anomaly Types ---
    pos_features = []
    pos_trilateration = []
    chunk = n_samples_per_class // 5

    # Type 1: Position Jumps (Implied Speed > 1200 km/h)
    for _ in range(chunk):
        speed_var = np.random.exponential(scale=50.0)
        heading_var = np.random.exponential(scale=20.0)
        alt_rate_var = np.random.exponential(scale=2.0)
        time_diff = np.random.normal(loc=8.0, scale=0.5)
        rule_flags = [1.0, 0.0, 0.0, 0.0, 0.0]
        pos_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)
        pos_trilateration.append(0.3) # distant receiver mismatch

    # Type 2: Duplicate ICAO (Cloned transponders)
    for _ in range(chunk):
        speed_var = np.random.exponential(scale=5.0)
        heading_var = np.random.exponential(scale=5.0)
        alt_rate_var = np.random.exponential(scale=0.5)
        time_diff = np.random.uniform(low=0.0, high=1.0)
        rule_flags = [0.0, 1.0, 0.0, 0.0, 0.0]
        pos_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)
        pos_trilateration.append(0.2)

    # Type 3: Impossible Climb Rate (> 50 m/s)
    for _ in range(chunk):
        speed_var = np.random.exponential(scale=10.0)
        heading_var = np.random.exponential(scale=10.0)
        alt_rate_var = np.random.exponential(scale=25.0)
        time_diff = np.random.normal(loc=8.0, scale=0.5)
        rule_flags = [0.0, 0.0, 1.0, 0.0, 0.0]
        pos_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)
        pos_trilateration.append(0.8)

    # Type 4: Altitude/Velocity Mismatch
    for _ in range(chunk):
        speed_var = np.random.exponential(scale=15.0)
        heading_var = np.random.exponential(scale=5.0)
        alt_rate_var = np.random.exponential(scale=1.0)
        time_diff = np.random.normal(loc=8.0, scale=0.5)
        rule_flags = [0.0, 0.0, 0.0, 1.0, 0.0]
        pos_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)
        pos_trilateration.append(0.5)

    # Type 5: Low Signal Confidence + Displacement (GPSJam.org style interference)
    for _ in range(n_samples_per_class - 4 * chunk):
        speed_var = np.random.exponential(scale=35.0)
        heading_var = np.random.exponential(scale=15.0)
        alt_rate_var = np.random.exponential(scale=1.5)
        time_diff = np.random.normal(loc=8.0, scale=0.5)
        rule_flags = [0.0, 0.0, 0.0, 0.0, 1.0]
        pos_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)
        pos_trilateration.append(0.4)

    X_pos = np.array(pos_features)
    y_pos = np.ones(n_samples_per_class)

    X = np.vstack((X_neg, X_pos))
    y = np.concatenate((y_neg, y_pos))
    trilateration = neg_trilateration + pos_trilateration

    return X, y, trilateration


def train_autoencoder_if_needed(autoencoder: UnsupervisedAutoencoder, X_train_normal: np.ndarray, epochs: int = 50):
    """Trains the autoencoder on clean training flights if weights file does not exist."""
    if not os.path.exists(AE_MODEL_PATH):
        print(f"Training unsupervised autoencoder on {len(X_train_normal)} normal flight samples...")
        optimizer = torch.optim.Adam(autoencoder.model.parameters(), lr=0.01)
        criterion = torch.nn.MSELoss()
        tensor_x = torch.FloatTensor(X_train_normal)

        autoencoder.model.train()
        for epoch in range(epochs):
            optimizer.zero_grad()
            reconstructed = autoencoder.model(tensor_x)
            loss = criterion(reconstructed, tensor_x)
            loss.backward()
            optimizer.step()

        autoencoder.model.eval()
        os.makedirs(os.path.dirname(AE_MODEL_PATH), exist_ok=True)
        torch.save(autoencoder.model.state_dict(), AE_MODEL_PATH)
        print(f"Autoencoder trained (final MSE: {loss.item():.4f}) and saved to {AE_MODEL_PATH}")
    else:
        autoencoder.load_weights()


def evaluate_configuration(
    config_name: str,
    X_test: np.ndarray,
    y_test: np.ndarray,
    tri_test: List[float],
    ensemble: TrustScoringEnsemble,
    autoencoder: UnsupervisedAutoencoder
) -> Dict[str, Any]:
    """Runs the held-out evaluation set through the specified architecture configuration."""
    predictions = []

    for i in range(len(X_test)):
        sample = X_test[i]
        rule_flags = [bool(f > 0.5) for f in sample[4:]]
        ae_features = sample[:4]
        tri_consistency = tri_test[i]

        # Individual layer evaluations
        ensemble_score, _ = ensemble.predict_anomaly(sample)
        ae_score = autoencoder.compute_anomaly_score(ae_features)

        if config_name == "rules-only":
            pred = any(rule_flags)

        elif config_name == "ensemble-only":
            # Supervised ensemble alone (threshold 0.50)
            pred = ensemble_score >= 0.50

        elif config_name == "autoencoder-only":
            # Unsupervised deep reconstruction alone (threshold 0.50)
            pred = ae_score >= 0.50

        elif config_name == "full-combined-pipeline":
            # Multi-layer weighted fusion with trilateration
            _, is_triggered = combine_scores(
                rule_flags=rule_flags,
                ensemble_score=ensemble_score,
                autoencoder_score=ae_score,
                trilateration_consistency=tri_consistency,
                threshold=0.70
            )
            pred = is_triggered

        else:
            raise ValueError(f"Unknown configuration name: {config_name}")

        predictions.append(int(pred))

    y_pred = np.array(predictions)
    cm = confusion_matrix(y_test, y_pred)
    tn, fp, fn, tp = cm.ravel()

    precision, recall, f1, _ = precision_recall_fscore_support(y_test, y_pred, average='binary', zero_division=0)
    fpr = float(fp / (fp + tn)) if (fp + tn) > 0 else 0.0

    return {
        "config_name": config_name,
        "tp": int(tp),
        "fp": int(fp),
        "tn": int(tn),
        "fn": int(fn),
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "fpr": float(fpr)
    }


async def main():
    print("=" * 80)
    print("AIRGUARD DETECTION PIPELINE - ARCHITECTURAL ABLATION STUDY")
    print("Evaluating held-out synthetic evaluation set across 4 configurations:")
    print("  1. rules-only")
    print("  2. ensemble-only (no rules, no autoencoder)")
    print("  3. autoencoder-only")
    print("  4. full-combined-pipeline (rules + ensemble + autoencoder + trilateration)")
    print("=" * 80)

    # 1. Generate full dataset and split 80/20 train/test
    X, y, tri = generate_ablation_dataset(n_samples_per_class=1000)
    indices = np.arange(len(X))
    train_idx, test_idx = train_test_split(indices, test_size=0.2, random_state=42)

    X_train = X[train_idx]
    y_train = y[train_idx]

    X_test = X[test_idx]
    y_test = y[test_idx]
    tri_test = [tri[i] for i in test_idx]

    print(f"Evaluation set size: {len(X_test)} samples ({int(np.sum(y_test == 0))} normal, {int(np.sum(y_test == 1))} anomalous)")

    # 2. Load models (train autoencoder on normal training data if needed)
    ensemble = TrustScoringEnsemble()
    autoencoder = UnsupervisedAutoencoder()
    train_autoencoder_if_needed(autoencoder, X_train[y_train == 0][:, :4])

    configs = [
        "rules-only",
        "ensemble-only",
        "autoencoder-only",
        "full-combined-pipeline"
    ]

    results = []
    print("\nRunning ablation evaluations...")
    for cfg in configs:
        res = evaluate_configuration(cfg, X_test, y_test, tri_test, ensemble, autoencoder)
        results.append(res)

    # 3. Print Results Summary Table
    print("\n" + "=" * 90)
    print(f"{'Configuration':<25} | {'Precision':<9} | {'Recall':<8} | {'F1-Score':<8} | {'FPR':<8} | {'TP':<4} | {'FP':<4} | {'TN':<4} | {'FN':<4}")
    print("-" * 90)
    for r in results:
        print(
            f"{r['config_name']:<25} | "
            f"{r['precision']:<9.4f} | "
            f"{r['recall']:<8.4f} | "
            f"{r['f1']:<8.4f} | "
            f"{r['fpr']:<8.4f} | "
            f"{r['tp']:<4} | "
            f"{r['fp']:<4} | "
            f"{r['tn']:<4} | "
            f"{r['fn']:<4}"
        )
    print("=" * 90)

    # Map config names to short versions (<= 20 chars for VARCHAR(20) model_version)
    version_map = {
        "rules-only": "abl-rules",
        "ensemble-only": "abl-ensemble",
        "autoencoder-only": "abl-ae",
        "full-combined-pipeline": "abl-combined"
    }

    # 4. Save each configuration run to PostgreSQL database
    print("\nRecording ablation runs into database (model_runs table)...")
    db_records_saved = 0
    try:
        async with async_session_maker() as session:
            for r in results:
                notes = (
                    f"Ablation: {r['config_name']} | "
                    f"FPR: {r['fpr']:.4f} | "
                    f"TP={r['tp']}, FP={r['fp']}, TN={r['tn']}, FN={r['fn']}"
                )
                db_run = ModelRun(
                    run_at=datetime.now(timezone.utc),
                    model_version=version_map.get(r['config_name'], "abl-run"),
                    true_positives=r['tp'],
                    false_positives=r['fp'],
                    true_negatives=r['tn'],
                    false_negatives=r['fn'],
                    precision=r['precision'],
                    recall=r['recall'],
                    f1=r['f1'],
                    notes=notes
                )
                session.add(db_run)
            await session.commit()
            db_records_saved = len(results)
        print(f"Successfully recorded all {db_records_saved} ablation runs to PostgreSQL.")
    except Exception as e:
        print(f"Warning: Could not save runs to database: {e}")

    # 5. Output key comparative takeaways
    best_single_f1 = max(r['f1'] for r in results[:3])
    best_single_fpr = min(r['fpr'] for r in results[:3])
    combined_res = results[3]
    
    print("\n" + "=" * 90)
    print("KEY ABLATION FINDINGS:")
    print(f"- Full Combined Pipeline F1:        {combined_res['f1']:.4f}")
    print(f"- Full Combined Pipeline FPR:       {combined_res['fpr']:.4f} (False Positive Rate)")
    print(f"- Best Single-Layer F1:            {best_single_f1:.4f}")
    print(f"- Best Single-Layer FPR:           {best_single_fpr:.4f}")
    print("=" * 90)

    return results

if __name__ == "__main__":
    asyncio.run(main())
