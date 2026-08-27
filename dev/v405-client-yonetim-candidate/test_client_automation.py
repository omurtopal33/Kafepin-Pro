from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HERE = Path(__file__).resolve().parent
SERVICE_PATH = HERE / "component" / "web_service.py"
SPEC = importlib.util.spec_from_file_location("client_yonetim_web_service", SERVICE_PATH)
service = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(service)


class FakeUser32:
    def __init__(self):
        self.restored = []

    def GetForegroundWindow(self):
        return 700

    def GetWindowRect(self, _hwnd, rect_pointer):
        rect = rect_pointer._obj
        rect.left, rect.top, rect.right, rect.bottom = 0, 0, 2568, 1400
        return True

    def GetDpiForWindow(self, _hwnd):
        return 96

    def SetWindowPos(self, *args):
        return True

    def ShowWindow(self, *args):
        return True

    def SetForegroundWindow(self, hwnd):
        self.restored.append(hwnd)
        return True


class FakeTime:
    def __init__(self):
        self.value = 0.0

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds

    def time(self):
        return 1_800_000_000 + self.value


class ClientAutomationTests(unittest.TestCase):
    def test_everycafe_database_is_opened_read_only(self):
        source = SERVICE_PATH.read_text(encoding="utf-8")
        self.assertIn("?mode=ro", source)
        forbidden = ("INSERT INTO", "UPDATE Clients", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE")
        automation = source[source.index("def everycafe_connection"):source.index("PRO_EVENT_URL")]
        for marker in forbidden:
            self.assertNotIn(marker, automation)

    def test_selection_tries_monitor_then_label_and_requires_visual_proof(self):
        clicks = []
        fake_time = FakeTime()

        def selection_visible(_x, _y):
            return len(clicks) >= 2

        with (
            mock.patch.object(service, "everycafe_card_point", return_value=(951, 415)),
            mock.patch.object(service, "activate_everycafe_window"),
            mock.patch.object(service, "_mouse_click", side_effect=lambda x, y, **_kw: clicks.append((x, y))),
            mock.patch.object(service, "everycafe_card_is_selected", side_effect=selection_visible),
            mock.patch.object(service.time, "monotonic", side_effect=fake_time.monotonic),
            mock.patch.object(service.time, "sleep", side_effect=fake_time.sleep),
        ):
            service.select_everycafe_card(10, "MASA-19")
        self.assertEqual(clicks, [(951, 415), (951, 507)])

    def test_selection_failure_stops_before_session_shortcut(self):
        keys = []
        with (
            mock.patch.object(service.ctypes.windll, "user32", FakeUser32()),
            mock.patch.object(service, "ensure_everycafe_window", return_value=(10, False)),
            mock.patch.object(service, "select_everycafe_card", side_effect=RuntimeError("selection failed")),
            mock.patch.object(service, "_key", side_effect=lambda *args: keys.append(args)),
        ):
            with self.assertRaisesRegex(RuntimeError, "selection failed"):
                service.invoke_everycafe_open("MASA-19", "timed", 60)
        self.assertEqual(keys, [])

    def _invoke_and_capture(self, mode, minutes=0):
        keys = []
        clicks = []
        fake_user32 = FakeUser32()
        with (
            mock.patch.object(service.ctypes.windll, "user32", fake_user32),
            mock.patch.object(service, "ensure_everycafe_window", return_value=(10, False)),
            mock.patch.object(service, "select_everycafe_card"),
            mock.patch.object(service, "_key", side_effect=lambda *args: keys.append(args)),
            mock.patch.object(service, "_mouse_click", side_effect=lambda *args, **kwargs: clicks.append((args, kwargs))),
            mock.patch.object(service.time, "sleep"),
        ):
            service.invoke_everycafe_open("MASA-19", mode, minutes)
        return keys, clicks

    def test_unlimited_uses_f5_not_double_click(self):
        keys, clicks = self._invoke_and_capture("unlimited")
        self.assertEqual(keys, [(0x74,), (0x0D,)])
        self.assertEqual(clicks, [])

    def test_timed_uses_everycafe_ctrl_shortcut(self):
        keys, clicks = self._invoke_and_capture("timed", 60)
        self.assertEqual(keys, [(0x34, (0x11,)), (0x0D,)])
        self.assertEqual(clicks, [])

    def test_free_uses_existing_star_button_after_selection(self):
        keys, clicks = self._invoke_and_capture("free")
        self.assertEqual(keys, [(0x0D,)])
        self.assertEqual(clicks[0][0], (836, 119))

    def test_run_open_waits_for_everycafe_waiting_status_not_ping_only(self):
        fake_time = FakeTime()
        invoked_at = []
        state = {"opened": False}

        def session_state(_client):
            if state["opened"]:
                return {"clientStatus": 1, "clientIP": "192.168.1.119", "active": {"SessionID": "ok"}, "queued": None}
            status = 2 if fake_time.value >= 60 else 8
            return {"clientStatus": status, "clientIP": "192.168.1.119", "active": None, "queued": None}

        def invoke(*_args):
            invoked_at.append(fake_time.value)
            state["opened"] = True

        job_id = "ready-test"
        service._session_jobs[job_id] = {"id": job_id}
        with (
            mock.patch.object(service, "session_state", side_effect=session_state),
            mock.patch.object(service, "probe_reachable", return_value=True),
            mock.patch.object(service, "wake_client"),
            mock.patch.object(service, "invoke_everycafe_open", side_effect=invoke),
            mock.patch.object(service.time, "monotonic", side_effect=fake_time.monotonic),
            mock.patch.object(service.time, "sleep", side_effect=fake_time.sleep),
            mock.patch.object(service.time, "time", side_effect=fake_time.time),
        ):
            service.run_open_session(job_id, "MASA-19", "unlimited", 0)
        self.assertEqual(invoked_at, [60.0])
        self.assertEqual(service.get_job(job_id)["state"], "done")

    def test_all_existing_http_actions_remain_present(self):
        source = SERVICE_PATH.read_text(encoding="utf-8")
        for marker in (
            '"wake": wake_client',
            '"restart": restart_client',
            '"terminate_apps": terminate_client_apps',
            'if path == "/api/open-session"',
            'if path == "/api/add-time"',
            'if path == "/api/clients"',
            'if path.startswith("/api/session-job/")',
        ):
            self.assertIn(marker, source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
