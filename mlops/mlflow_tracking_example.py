"""
Reference pattern for training scripts once real models replace the mock
services (e.g. training a complaint classifier on accumulated labeled data,
or a TFT forecaster on historical traffic readings). Not wired to a live
MLflow server in the POC — this is the convention to follow when one exists.
"""
import mlflow


def train_and_log(model_name: str, params: dict, train_fn):
    mlflow.set_experiment(f"smartcity-{model_name}")
    with mlflow.start_run():
        mlflow.log_params(params)

        model, metrics = train_fn(params)

        mlflow.log_metrics(metrics)
        mlflow.sklearn.log_model(model, artifact_path=model_name, registered_model_name=model_name)

        return model, metrics


if __name__ == "__main__":
    # Example only — replace with a real training function per model.
    def _dummy_train_fn(params):
        class DummyModel:
            pass
        return DummyModel(), {"f1_score": 0.0}

    train_and_log("complaint-classifier", {"lr": 1e-4, "epochs": 5}, _dummy_train_fn)
