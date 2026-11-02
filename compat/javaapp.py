"""Drives the original Java Utility Soft through compat/Harness.java (Linux + Xvfb)."""
import os
import re
import socket
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
JDK = Path(os.environ.get('JAVA_HOME', Path.home() / 'tools' / 'jdk8'))
JAVA_SRC = Path(os.environ.get('JAVA_SRC', HERE.parent.parent / 'Utility-Soft'))
DISPLAY = os.environ.get('COMPAT_DISPLAY', ':77')  # never the shared :99 browser display


def ensure_display():
    if subprocess.run(['pgrep', '-f', f'Xvfb {DISPLAY} '], capture_output=True).returncode != 0:
        subprocess.Popen(['Xvfb', DISPLAY, '-screen', '0', '1366x768x24', '-nolisten', 'tcp'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)


def prepare_program_dir(d: Path):
    """The Java code builds some paths with backslashes (Windows only); on Linux
    those become file names in the working folder, so link them to the real files."""
    win = str(d).replace('/', '\\')
    for name in ('impinfo.txt', 'ddown.txt'):
        link = d / f'{win}\\{name}'
        if not link.exists():
            link.symlink_to(name)


def cleanup_program_dir(d: Path):
    for p in d.iterdir():
        if p.name.startswith('\\'):
            p.unlink()


class JavaApp:
    def __init__(self, program_dir: Path, port: int = 7101):
        self.dir = Path(program_dir)
        self.port = port
        self.proc = None
        self.sock = None

    def __enter__(self):
        ensure_display()
        prepare_program_dir(self.dir)
        cp = ':'.join([str(HERE / '.build' / 'classes')] + [str(p) for p in sorted((JAVA_SRC / 'lib').glob('*.jar'))])
        self.log = open(self.dir.parent / f'java-{self.port}.log', 'w')
        self.proc = subprocess.Popen([str(JDK / 'bin' / 'java'), '-cp', cp, 'Harness', str(self.port), 'Frames.passwordpro'],
                                     cwd=self.dir, env={**os.environ, 'DISPLAY': DISPLAY}, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                self.sock = socket.create_connection(('127.0.0.1', self.port))
                break
            except OSError:
                time.sleep(0.1)
        self.f = self.sock.makefile('rw', encoding='utf-8', newline='\n')
        time.sleep(1.0)
        return self

    def __exit__(self, *a):
        try:
            self.sock.close()
        finally:
            self.proc.kill()
            self.proc.wait()
            cleanup_program_dir(self.dir)

    def cmd(self, c: str) -> str:
        self.f.write(c + '\n')
        self.f.flush()
        out = []
        for line in self.f:
            line = line.rstrip('\n')
            if line == '<<END>>':
                break
            out.append(line)
        res = '\n'.join(out)
        if res.startswith('ERROR'):
            raise RuntimeError(f'{c}: {res}')
        return res

    def wait(self, ms=600):
        self.cmd(f'sleep {ms}')

    def click(self, text: str, n: int = 0):
        r = self.cmd(f"click {text.replace(' ', '_')} {n}")
        if 'not found' in r:
            raise RuntimeError(f'button {text!r} not found')
        self.wait()

    def mouse_click(self, text: str):
        """For buttons that react to mouse events instead of actions."""
        xy = self.cmd(f"locate {text.replace(' ', '_')}")
        if 'not found' in xy:
            raise RuntimeError(f'button {text!r} not found')
        self.cmd(f'mouse {xy}')
        self.wait()

    def show_options(self):
        """Shows the bill editor's button panel (it appears while the mouse is over 'OPTIONS')."""
        if 'not found' not in self.cmd('locate OPTIONS'):
            self.mouse_click('OPTIONS')

    def bills_button(self, text: str):
        """Buttons of the bill editor are on a panel that appears when the mouse is over 'OPTIONS'."""
        if 'not found' in self.cmd(f"locate {text.replace(' ', '_')}"):
            self.mouse_click('OPTIONS')
        self.click(text)

    def windows(self) -> list[str]:
        return [l.split(' | ')[0] for l in self.cmd('windows').splitlines() if l.strip()]

    def dump(self) -> str:
        return self.cmd('dump')

    def window(self, cls: str) -> str:
        """Dump section of one window class (e.g. 'Frames.billing')."""
        d = self.dump()
        parts = re.split(r'(?m)^WINDOW ', d)
        for p in parts:
            if p.startswith(cls + ' '):
                return p
        raise RuntimeError(f'window {cls} not showing; have: {self.windows()}')

    def tables(self, cls: str) -> list[dict]:
        """Tables in a window: [{'cols': [...], 'rows': [[cells...], ...]}]."""
        out = []
        for m in re.finditer(r'table cols=(.*?)\| selected=\[.*?\]((?:\n\s+r\d+: .*)*)', self.window(cls)):
            cols = m.group(1).split('|')
            rows = []
            for rl in m.group(2).strip('\n').splitlines():
                cells = rl.split(': ', 1)[1].split(' | ')
                rows.append([c.strip() for c in cells[:len(cols)]])
            out.append({'cols': cols, 'rows': rows})
        return out

    def login(self, password='puja'):
        self.cmd(f'settext 0 {password}')
        self.click('OK')
        self.wait(1500)
