import numpy as np

from voice_pipeline.loudness import RelativeLoudnessGate


def frame(amplitude: float) -> bytes:
    return np.full(320, amplitude * 32767, dtype=np.int16).tobytes()


def admitted(gate, amplitudes):
    return [gate.admits(frame(a), True) for a in amplitudes]


def test_quieter_speech_is_discarded_beyond_the_margin():
    gate = RelativeLoudnessGate(margin_db=10)
    loud, background = 0.1, 0.01  # 20 dB apart
    assert admitted(gate, [loud] * 20) == [True] * 20
    assert admitted(gate, [background] * 20)[-1] is False


def test_speech_within_the_margin_is_kept():
    gate = RelativeLoudnessGate(margin_db=10)
    admitted(gate, [0.1] * 20)
    assert admitted(gate, [0.05] * 20)[-1] is True  # 6 dB down


def test_background_before_the_caller_is_admitted():
    gate = RelativeLoudnessGate(margin_db=10)
    assert admitted(gate, [0.01] * 20)[-1] is True


def test_loudest_level_fades():
    gate = RelativeLoudnessGate(margin_db=10, decay_db_per_s=10)
    admitted(gate, [0.1] * 20)
    quieter = admitted(gate, [0.01] * 100)  # 2 s: loudest drops 20 dB
    assert quieter[20] is False and quieter[-1] is True


def test_non_speech_is_never_admitted():
    gate = RelativeLoudnessGate(margin_db=10)
    assert gate.admits(frame(0.1), False) is False


def test_zero_margin_admits_all_speech():
    gate = RelativeLoudnessGate(margin_db=0)
    admitted(gate, [0.1] * 20)
    assert admitted(gate, [0.001] * 20)[-1] is True


def test_reset_forgets_the_loudest_level():
    gate = RelativeLoudnessGate(margin_db=10)
    admitted(gate, [0.1] * 20)
    gate.reset()
    assert admitted(gate, [0.001] * 20)[-1] is True
