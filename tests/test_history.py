"""SQLite chat history: owners are isolated, 5 chats per person, deletes cascade, old chats expire."""

import time

import pytest

from jira_pm.history import ChatStore, title_of


@pytest.fixture
def store(tmp_path):
    return ChatStore(tmp_path / "chats.sqlite3")


def test_save_and_read_back(store):
    store.add_exchange("amit@x.com", "c1", "bugs in form builder?", "12 bugs", [{"tool": "bugs_in_feature", "args": "{}"}], 2.5)
    store.add_exchange("amit@x.com", "c1", "and voter module?", "28 bugs")
    conv = store.get("amit@x.com", "c1")
    assert conv["title"] == "bugs in form builder?"
    assert [(m["role"], m["text"]) for m in conv["messages"]] == [
        ("user", "bugs in form builder?"), ("bot", "12 bugs"), ("user", "and voter module?"), ("bot", "28 bugs")]
    assert conv["messages"][1]["tools"][0]["tool"] == "bugs_in_feature" and conv["messages"][1]["seconds"] == 2.5
    assert store.turns("amit@x.com", "c1")[-1] == {"role": "bot", "text": "28 bugs"}


def test_owners_cannot_see_or_touch_each_others_chats(store):
    store.add_exchange("amit@x.com", "c1", "my secret question", "answer")
    assert store.recent("ravi@x.com") == []
    assert store.get("ravi@x.com", "c1") is None
    assert store.turns("ravi@x.com", "c1") == []
    assert store.delete("ravi@x.com", "c1") is False and store.get("amit@x.com", "c1")      # still there
    with pytest.raises(PermissionError):
        store.add_exchange("ravi@x.com", "c1", "hijack", "x")                                # can't write into it


def test_only_the_newest_five_chats_are_kept_per_person(store):
    for i in range(7):
        store.add_exchange("amit@x.com", f"c{i}", f"question {i}", "a")
        time.sleep(0.002)
    store.add_exchange("ravi@x.com", "r1", "ravi's chat", "a")
    assert [c["title"] for c in store.recent("amit@x.com")] == [f"question {i}" for i in (6, 5, 4, 3, 2)]
    assert store.get("amit@x.com", "c0") is None                                             # oldest deleted
    assert len(store.recent("ravi@x.com")) == 1                                                # other person unaffected


def test_continuing_an_old_chat_moves_it_to_the_top(store):
    store.add_exchange("amit@x.com", "old", "old chat", "a")
    time.sleep(0.002)
    store.add_exchange("amit@x.com", "new", "new chat", "a")
    time.sleep(0.002)
    store.add_exchange("amit@x.com", "old", "follow-up", "b")
    assert [c["id"] for c in store.recent("amit@x.com")] == ["old", "new"]


def test_delete_removes_messages_too(store):
    store.add_exchange("amit@x.com", "c1", "q", "a")
    assert store.delete("amit@x.com", "c1") is True
    assert store._db.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0


def test_old_chats_expire(store):
    store.add_exchange("amit@x.com", "c1", "q", "a")
    store._db.execute("UPDATE conversations SET updated_at = ?", (time.time() - 91 * 86400,))
    store._db.commit()
    assert store.purge_old() == 1 and store.recent("amit@x.com") == []


def test_history_survives_a_restart(tmp_path):
    ChatStore(tmp_path / "c.sqlite3").add_exchange("amit@x.com", "c1", "q", "a")
    assert ChatStore(tmp_path / "c.sqlite3").get("amit@x.com", "c1")["messages"][0]["text"] == "q"   # new process


def test_titles_are_short_and_tidy():
    assert title_of("  bugs\n in   form builder ") == "bugs in form builder"
    assert len(title_of("x" * 200)) == 58 and title_of("x" * 200).endswith("…")


def test_lru_opening_a_chat_counts_as_using_it(store):
    """Five chats, open the oldest, start a 6th: the one removed is the least recently USED, not the oldest."""
    for i in range(5):
        store.add_exchange("amit@x.com", f"c{i}", f"question {i}", "a")
        time.sleep(0.002)
    assert store.get("amit@x.com", "c0", touch=True)                     # opened in the sidebar
    time.sleep(0.002)
    store.add_exchange("amit@x.com", "c5", "question 5", "a")
    ids = [c["id"] for c in store.recent("amit@x.com")]
    assert "c0" in ids and "c1" not in ids and ids[:2] == ["c5", "c0"]


def test_reading_without_touch_does_not_reorder(store):
    store.add_exchange("amit@x.com", "a", "first", "x")
    time.sleep(0.002)
    store.add_exchange("amit@x.com", "b", "second", "x")
    store.get("amit@x.com", "a")
    store.turns("amit@x.com", "a")                                       # the agent re-reading context is not "use"
    assert [c["id"] for c in store.recent("amit@x.com")] == ["b", "a"]
