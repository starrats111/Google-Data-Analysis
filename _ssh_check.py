import paramiko, json

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", port=22, username="admin", password="A123456", timeout=15)

cmd1 = "cat /home/admin/service_account.json"
stdin, stdout, stderr = ssh.exec_command(cmd1)
raw = stdout.read().decode()
err1 = stderr.read().decode()
if err1:
    print("STDERR cmd1:", err1)
else:
    d = json.loads(raw)
    print("CLIENT_EMAIL:", d.get("client_email", "N/A"))
    print("PROJECT_ID:", d.get("project_id", "N/A"))

cmd2 = "grep client_email /home/admin/service_account.json"
stdin, stdout, stderr = ssh.exec_command(cmd2)
out2 = stdout.read().decode()
err2 = stderr.read().decode()
print()
print("=== grep client_email ===")
print(out2)
if err2:
    print("STDERR cmd2:", err2)

ssh.close()
