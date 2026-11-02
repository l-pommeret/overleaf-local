#!/usr/bin/env python3
"""Lance une commande dans un pseudo-terminal pour l'onglet Terminal de l'agent.

    terminal.py COLONNES LIGNES commande [args…]

stdin/stdout relaient le terminal ; le descripteur 3 reçoit des lignes
« COLONNES LIGNES » pour redimensionner. Uniquement la bibliothèque standard.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]


def main():
    cols, rows, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)

    def resize(c, r):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)

    resize(cols, rows)
    inputs = [master, 0, 3]
    control = b""
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if data:
                write_all(master, data)
            else:
                inputs.remove(0)
                os.kill(pid, signal.SIGHUP)
        if 3 in ready:
            data = os.read(3, 4096)
            if not data:
                inputs.remove(3)
            control += data
            while b"\n" in control:
                line, control = control.split(b"\n", 1)
                try:
                    c, r = map(int, line.split())
                    resize(max(c, 20), max(r, 5))
                except (ValueError, OSError):
                    pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)


if __name__ == "__main__":
    main()
