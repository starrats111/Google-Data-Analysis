"""SSH remote command with long timeout"""
import sys
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def run(cmd, timeout=300):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, PORT, USER, PASS, timeout=10)
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        stdout.channel.settimeout(timeout)
        stderr.channel.settimeout(timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        if out:
            sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))
            sys.stdout.buffer.write(b"\n")
            sys.stdout.buffer.flush()
        if err:
            sys.stdout.buffer.write(f"[STDERR] {err}\n".encode("utf-8", errors="replace"))
            sys.stdout.buffer.flush()
        return code
    finally:
        client.close()

if __name__ == "__main__":
    cmd = " ".join(sys.argv[1:])
    code = run(cmd)
    sys.exit(code)
