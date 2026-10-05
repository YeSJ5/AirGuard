import os

import joblib
import numpy as np
import pytest
from sklearn.ensemble import (
    GradientBoostingClassifier,
    RandomForestClassifier,
    VotingClassifier,
)

from app.detection.ensemble import TrustScoringEnsemble
from scripts.train_ensemble import generate_synthetic_data


def test_generate_synthetic_data():
    X, y = generate_synthetic_data(n_samples_per_class=100)
    assert X.shape == (200, 9)
    assert y.shape == (200,)
    assert np.all((y == 0) | (y == 1))


def test_ensemble_fallback():
    # Force load a non-existent model to test fallback
    with pytest.MonkeyPatch.context() as m:
        m.setattr("app.detection.ensemble.MODEL_PATH", "non_existent_model_file.joblib")
        ensemble = TrustScoringEnsemble()
        assert ensemble.model is None

        # Test input vector with position jump triggered (9 features)
        feature_vector = np.array([0.0, 0.0, 0.0, 8.0, 1.0, 0.0, 0.0, 0.0, 0.0])
        prob, explanation = ensemble.predict_anomaly(feature_vector)

        assert prob is None
        assert explanation["status"] == "unavailable"
        assert explanation["reason"] == "No trained ensemble model is loaded."


def test_disabled_ensemble_does_not_load_artifact(monkeypatch):
    def fail_if_loaded(_path):
        raise AssertionError("disabled live ML must not deserialize an artifact")

    monkeypatch.setattr("app.detection.ensemble.joblib.load", fail_if_loaded)
    ensemble = TrustScoringEnsemble(load_artifact=False)

    assert ensemble.model is None
    assert ensemble.predict_anomaly(np.zeros(9))[0] is None


def test_ensemble_training_and_shap():
    # Train a mini ensemble and save it to a temporary test file path
    temp_model_path = "test_ensemble_model.joblib"

    # Generate tiny training set
    X_train, y_train = generate_synthetic_data(n_samples_per_class=20)

    rf = RandomForestClassifier(n_estimators=10, max_depth=3, random_state=42)
    gb = GradientBoostingClassifier(n_estimators=10, max_depth=2, random_state=42)
    model = VotingClassifier(estimators=[("rf", rf), ("gb", gb)], voting="soft")
    model.fit(X_train, y_train)

    # Save to temp path
    joblib.dump(model, temp_model_path)

    try:
        # Patch MODEL_PATH to use the temp model
        with pytest.MonkeyPatch.context() as m:
            m.setattr("app.detection.ensemble.MODEL_PATH", temp_model_path)

            ensemble = TrustScoringEnsemble()
            assert ensemble.model is not None
            assert ensemble.get_explainer() is not None
            assert ensemble.explainer is not None

            # Predict normal vector (all zeros, 9 features)
            normal_vector = np.array([0.0, 0.0, 0.0, 8.0, 0.0, 0.0, 0.0, 0.0, 0.0])
            prob_norm, expl_norm = ensemble.predict_anomaly(normal_vector)

            assert 0.0 <= prob_norm <= 1.0
            assert len(expl_norm["top_features"]) == 3
            # Top features should have SHAP values
            for feat in expl_norm["top_features"]:
                assert "feature" in feat
                assert "value" in feat
                assert isinstance(feat["value"], float)

            # Predict anomaly vector (all rule flags triggered, 9 features)
            anomaly_vector = np.array([50.0, 20.0, 10.0, 8.0, 1.0, 1.0, 1.0, 1.0, 1.0])
            prob_anom, expl_anom = ensemble.predict_anomaly(anomaly_vector)
            assert prob_anom > prob_norm

    finally:
        # Clean up
        if os.path.exists(temp_model_path):
            os.remove(temp_model_path)
