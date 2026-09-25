"""
Citizen Complaint Analysis (Module 3).

This is the one NLP module implemented with real, working logic rather than
a mock — it needs no GPU and no external API, so it's genuinely production-
usable on day one for a small-to-medium complaint volume. At higher volume,
or when a labeled dataset accumulates, swap `_classify_category` and
`_sentiment` for a fine-tuned transformer (see ARCHITECTURE.md) without
touching the router or the response schema.

Pipeline:
  1. Category classification   — keyword/lexicon scoring across categories
  2. Sentiment analysis        — lexicon-based polarity + negation handling
  3. Location extraction       — regex + landmark gazetteer match
  4. Priority prediction       — weighted function of category, sentiment,
                                  safety keywords, and recency signals
  5. Department routing       — category -> department lookup table
"""
import re
from dataclasses import dataclass
from typing import Optional

from app.schemas.complaint import ComplaintAnalysis

# --- Category lexicon --------------------------------------------------
CATEGORY_KEYWORDS = {
    "pothole": ["pothole", "pot hole", "hole in the road", "crater", "sunken road", "broken pavement"],
    "traffic_signal": ["signal", "traffic light", "stoplight", "red light not working", "signal broken"],
    "flooding": ["waterlogging", "flood", "water logged", "drain", "sewage", "standing water"],
    "signage": ["sign missing", "no sign", "road sign", "missing signage", "stop sign"],
    "streetlight": ["street light", "streetlight", "lamp post", "dark road", "no light"],
    "congestion": ["traffic jam", "congestion", "bumper to bumper", "gridlock", "stuck in traffic"],
    "accident_risk": ["accident", "near miss", "collision", "dangerous crossing", "unsafe intersection"],
    "other": [],
}

DEPARTMENT_ROUTING = {
    "pothole": "roads_maintenance",
    "traffic_signal": "traffic_signals",
    "flooding": "drainage",
    "signage": "roads_maintenance",
    "streetlight": "public_works_electrical",
    "congestion": "traffic_management",
    "accident_risk": "traffic_police",
    "other": "general_admin",
}

# --- Sentiment lexicon (simple, explainable, no black box) -------------
NEGATIVE_WORDS = {
    "broken", "huge", "dangerous", "unsafe", "terrible", "awful", "worse", "worst",
    "flooded", "blocked", "ignored", "weeks", "months", "again", "still", "never",
    "urgent", "emergency", "injured", "accident", "crash", "angry", "frustrated",
}
POSITIVE_WORDS = {"thank", "thanks", "great", "fixed", "quick", "appreciate", "good job", "resolved"}
NEGATION_WORDS = {"not", "no", "never", "n't"}

SAFETY_KEYWORDS = {"accident", "injured", "collision", "crash", "child", "school", "hospital", "ambulance", "blind spot"}

# --- Very small landmark gazetteer for location extraction --------------
# In production this is a real geocoder (Google/Mapbox) + a city landmark table.
LANDMARK_GAZETTEER = {
    "hospital": (25.4052, 55.4033),
    "school": (25.4111, 55.4372),
    "main market": (25.3995, 55.4180),
    "central mall": (25.4123, 55.4310),
    "bus station": (25.3978, 55.4260),
    "corniche": (25.4180, 55.4450),
}

LOCATION_PATTERN = re.compile(
    r"\bnear\s+(the\s+)?([a-zA-Z ]{3,40}?)(?:[.,!]|$)", re.IGNORECASE
)


@dataclass
class _ScoredCategory:
    category: str
    score: int


def _classify_category(text: str) -> str:
    lower = text.lower()
    best: Optional[_ScoredCategory] = None
    for category, keywords in CATEGORY_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in lower)
        if score > 0 and (best is None or score > best.score):
            best = _ScoredCategory(category, score)
    return best.category if best else "other"


def _sentiment(text: str) -> tuple[str, float]:
    tokens = re.findall(r"[a-z']+", text.lower())
    pos = sum(1 for t in tokens if t in POSITIVE_WORDS)
    neg = sum(1 for t in tokens if t in NEGATIVE_WORDS)

    # crude negation flip: "not fixed" should read negative even though
    # "fixed" is a positive-lexicon word
    for i, t in enumerate(tokens):
        if t in NEGATION_WORDS and i + 1 < len(tokens) and tokens[i + 1] in POSITIVE_WORDS:
            pos -= 1
            neg += 1

    raw = pos - neg
    if raw == 0 and pos == 0 and neg == 0:
        return "neutral", 0.0

    # normalize to -1..1
    score = max(-1.0, min(1.0, raw / max(1, pos + neg)))
    if score > 0.15:
        return "positive", score
    if score < -0.15:
        return "negative", score
    return "neutral", score


def _extract_location(text: str) -> tuple[Optional[str], Optional[float], Optional[float]]:
    match = LOCATION_PATTERN.search(text)
    location_text = match.group(2).strip() if match else None

    lower = text.lower()
    for landmark, (lat, lon) in LANDMARK_GAZETTEER.items():
        if landmark in lower:
            return landmark, lat, lon

    return location_text, None, None


def _priority(category: str, sentiment_score: float, text: str) -> tuple[str, float]:
    lower = text.lower()
    base = {
        "accident_risk": 0.8,
        "traffic_signal": 0.55,
        "flooding": 0.6,
        "pothole": 0.45,
        "streetlight": 0.4,
        "signage": 0.35,
        "congestion": 0.3,
        "other": 0.2,
    }.get(category, 0.2)

    safety_bonus = 0.25 if any(kw in lower for kw in SAFETY_KEYWORDS) else 0.0
    urgency_bonus = 0.15 if any(w in lower for w in ["weeks", "months", "still", "again"]) else 0.0
    sentiment_bonus = max(0.0, -sentiment_score) * 0.15  # more negative -> slightly higher priority

    score = min(1.0, base + safety_bonus + urgency_bonus + sentiment_bonus)

    if score >= 0.75:
        label = "critical"
    elif score >= 0.55:
        label = "high"
    elif score >= 0.35:
        label = "medium"
    else:
        label = "low"

    return label, round(score, 2)


class ComplaintNLPService:
    """Public interface. Router code only ever calls `.analyze()`."""

    def analyze(self, text: str) -> ComplaintAnalysis:
        category = _classify_category(text)
        sentiment, sentiment_score = _sentiment(text)
        location_text, lat, lon = _extract_location(text)
        priority, priority_score = _priority(category, sentiment_score, text)
        department = DEPARTMENT_ROUTING[category]

        return ComplaintAnalysis(
            category=category,
            sentiment=sentiment,
            sentiment_score=round(sentiment_score, 2),
            priority=priority,
            priority_score=priority_score,
            department=department,
            location_text=location_text,
            lat=lat,
            lon=lon,
        )


complaint_nlp_service = ComplaintNLPService()
