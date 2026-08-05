import asyncio
import os
import sys
from typing import Tuple
import numpy as np
import joblib
from datetime import datetime, timezone
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier, VotingClassifier
from sklearn.metrics import precision_recall_fscore_support, confusion_matrix

# Add backend directory to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.core.database import async_session_maker, Base, engine
from app.models import ModelRun
from app.detection.ensemble import FEATURE_NAMES, MODEL_PATH

def generate_synthetic_data(n_samples_per_class: int = 1000) -> Tuple[np.ndarray, np.ndarray]:
    """Generate synthetic training dataset mimicking normal and anomalous flight telemetry.

    Features:
    [speed_var, heading_var, alt_rate_var, time_diff, rule_pos_jump, rule_dup_icao, rule_climb_rate, rule_alt_vel_mismatch]
    """
    np.random.seed(42)
    
    # --- Negative Class: Normal Flight Dynamics (Label 0) ---
    neg_features = []
    for _ in range(n_samples_per_class):
        speed_var = np.random.exponential(scale=2.0) # low speed variance
        heading_var = np.random.exponential(scale=5.0) # low heading variance
        alt_rate_var = np.random.exponential(scale=0.5) # low climb rate variance
        time_diff = np.random.normal(loc=8.0, scale=0.5) # standard 8s polling interval
        
        # Rule flags are zero for clean flights
        rule_flags = [0.0, 0.0, 0.0, 0.0]
        
        neg_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)
        
    X_neg = np.array(neg_features)
    y_neg = np.zeros(n_samples_per_class)

    # --- Positive Class: Injected Anomalies (Label 1) ---
    pos_features = []
    
    # Type 1: Position Jumps (Implied Speed > 1200 km/h)
    for _ in range(n_samples_per_class // 4):
        speed_var = np.random.exponential(scale=50.0) # high speed variance
        heading_var = np.random.exponential(scale=20.0)
        alt_rate_var = np.random.exponential(scale=2.0)
        time_diff = np.random.normal(loc=8.0, scale=0.5)
        rule_flags = [1.0, 0.0, 0.0, 0.0] # position jump rule triggered
        pos_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)

    # Type 2: Duplicate ICAO (Cloned transponders reporting far apart)
    for _ in range(n_samples_per_class // 4):
        speed_var = np.random.exponential(scale=5.0)
        heading_var = np.random.exponential(scale=5.0)
        alt_rate_var = np.random.exponential(scale=0.5)
        time_diff = np.random.uniform(low=0.0, high=1.0) # same-second reports
        rule_flags = [0.0, 1.0, 0.0, 0.0] # duplicate ICAO triggered
        pos_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)

    # Type 3: Impossible Climb Rate (vertical rate > 50 m/s)
    for _ in range(n_samples_per_class // 4):
        speed_var = np.random.exponential(scale=10.0)
        heading_var = np.random.exponential(scale=10.0)
        alt_rate_var = np.random.exponential(scale=25.0) # high climb rate variance
        time_diff = np.random.normal(loc=8.0, scale=0.5)
        rule_flags = [0.0, 0.0, 1.0, 0.0] # climb rate rule triggered
        pos_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)

    # Type 4: Altitude/Velocity Mismatch (e.g. taxiing at 30k feet)
    for _ in range(n_samples_per_class // 4):
        speed_var = np.random.exponential(scale=15.0)
        heading_var = np.random.exponential(scale=5.0)
        alt_rate_var = np.random.exponential(scale=1.0)
        time_diff = np.random.normal(loc=8.0, scale=0.5)
        rule_flags = [0.0, 0.0, 0.0, 1.0] # alt/vel mismatch rule triggered
        pos_features.append([speed_var, heading_var, alt_rate_var, time_diff] + rule_flags)

    X_pos = np.array(pos_features)
    y_pos = np.ones(n_samples_per_class)

    # Combine classes
    X = np.vstack((X_neg, X_pos))
    y = np.concatenate((y_neg, y_pos))
    
    return X, y

async def main():
    print("Generating synthetic training dataset...")
    X, y = generate_synthetic_data()

    print("Splitting train and test sets...")
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    print("Building Soft-Voting Ensemble model (RandomForest + GradientBoosting)...")
    rf = RandomForestClassifier(n_estimators=100, max_depth=5, random_state=42)
    gb = GradientBoostingClassifier(n_estimators=100, max_depth=3, random_state=42)
    
    ensemble = VotingClassifier(
        estimators=[('rf', rf), ('gb', gb)],
        voting='soft'
    )

    print("Training ensemble...")
    ensemble.fit(X_train, y_train)

    print("Evaluating ensemble performance...")
    y_pred = ensemble.predict(X_test)
    precision, recall, f1, _ = precision_recall_fscore_support(y_test, y_pred, average='binary')
    cm = confusion_matrix(y_test, y_pred)
    tn, fp, fn, tp = cm.ravel()

    print(f"Ensemble Precision: {precision:.4f}")
    print(f"Ensemble Recall:    {recall:.4f}")
    print(f"Ensemble F1 Score:  {f1:.4f}")
    print(f"Confusion Matrix:\n{cm}")

    # Ensure output folder exists
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    print(f"Saving trained model weights to: {MODEL_PATH}")
    joblib.dump(ensemble, MODEL_PATH)

    # Database recording
    run_notes = (
        f"Synthetic dataset training runs. Normal samples: 1000, Anomaly samples: 1000. "
        f"Feature columns: {', '.join(FEATURE_NAMES)}."
    )
    
    try:
        print("Saving model run metrics to PostgreSQL database...")
        async with async_session_maker() as session:
            run = ModelRun(
                run_at=datetime.now(timezone.utc),
                model_version="v0.1.0",
                true_positives=int(tp),
                false_positives=int(fp),
                true_negatives=int(tn),
                false_negatives=int(fn),
                precision=float(precision),
                recall=float(recall),
                f1=float(f1),
                notes=run_notes
            )
            session.add(run)
            await session.commit()
        print("Model run statistics stored successfully in database.")
    except Exception as e:
        print(f"Database unavailable to record metrics: {e}")
        print("Note: Run statistics printed above. Continuing execution...")

if __name__ == "__main__":
    from typing import Tuple # for type annotation compatibility in older pythons
    asyncio.run(main())
