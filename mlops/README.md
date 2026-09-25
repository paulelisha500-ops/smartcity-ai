# MLOps

Conventions for when the mock services in `backend/app/services/` are swapped
for trained models.

## Experiment tracking (MLflow)

Every model training run logs:
- Dataset version (labeled complaint set, CV training imagery set, historical
  traffic readings window)
- Hyperparameters
- Metrics: for forecasting, MAPE/RMSE per intersection; for CV, mAP@0.5; for
  NLP classifier, F1 per category
- The resulting artifact (model checkpoint), registered under a name matching
  the service it replaces, e.g. `traffic-cv-yolo`, `complaint-classifier`,
  `congestion-tft`.

See `mlflow_tracking_example.py` for the logging pattern used across all
training scripts.

## Model registry stages

`staging` → validated against a held-out backtest window, not yet serving
`production` → promoted after passing the phase-gate metric bar in
`docs/ROADMAP.md`
`archived` → superseded

## Promotion gate

A new model version is only promoted to `production` if it beats the
currently-serving model (or, for a first production model, the mock/
baseline heuristic) on the held-out evaluation set. This is what justifies
the "mock mode" baselines existing at all — they're the bar the real model
has to clear.
