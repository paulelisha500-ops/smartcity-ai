"""The planner's retrieval step: question words against fact tags."""
import pytest

from app.routers.planner import _assemble_facts
from app.services.rag_planner import _matches, rag_planner_service

TAGS = {"road", "widen", "junction", "congestion"}


@pytest.mark.parametrize("word", ["road", "roads", "widened", "widening", "junctions"])
def test_inflected_words_match_their_tag(word):
    assert _matches(word, TAGS)


@pytest.mark.parametrize("word", ["", "ro", "the", "rod", "international"])
def test_unrelated_or_short_words_do_not_match(word):
    assert not _matches(word, TAGS)


@pytest.mark.parametrize("question", [
    "Show the busiest junctions",
    "Which roads should be widened?",
    "What needs maintenance most urgently?",
])
def test_every_suggested_question_retrieves_facts(question):
    # These are the suggestions offered on the planner page; one that
    # retrieves nothing answers "not enough data" to its own prompt.
    result = rag_planner_service.answer(question, _assemble_facts())
    assert result["sources_used"]


def test_a_question_with_no_matching_words_says_so():
    result = rag_planner_service.answer("What is the weather tomorrow?", _assemble_facts())
    assert result["sources_used"] == []
