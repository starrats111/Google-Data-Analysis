"""Setup MariaDB: low-memory config, create databases, create user"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

# Step 1: Configure MariaDB for low memory (150MB max)
mariadb_config = """[mysqld]
innodb_buffer_pool_size = 64M
innodb_log_file_size = 16M
innodb_log_buffer_size = 4M
key_buffer_size = 8M
max_connections = 20
thread_cache_size = 4
table_open_cache = 128
sort_buffer_size = 256K
read_buffer_size = 256K
read_rnd_buffer_size = 256K
join_buffer_size = 256K
tmp_table_size = 16M
max_heap_table_size = 16M
query_cache_size = 0
performance_schema = OFF
character-set-server = utf8mb4
collation-server = utf8mb4_general_ci
"""

sftp = client.open_sftp()
with sftp.open('/tmp/99-lowmem.cnf', 'w') as f:
    f.write(mariadb_config)
sftp.close()

commands = [
    "sudo cp /tmp/99-lowmem.cnf /etc/mysql/mariadb.conf.d/99-lowmem.cnf",
    "sudo systemctl restart mariadb",
    "sleep 2",
    "sudo systemctl status mariadb | head -5",
]

for cmd in commands:
    print(f">>> {cmd}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out:
        print(out)
    if err and 'Warning' not in err:
        print(f"[STDERR] {err}")

# Step 2: Create databases and user
sql_commands = """
CREATE DATABASE IF NOT EXISTS \`google-data-analysis\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE DATABASE IF NOT EXISTS \`google-data-analysis_shadow\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER IF NOT EXISTS 'crm'@'localhost' IDENTIFIED BY 'CrmPass2026!';
GRANT ALL PRIVILEGES ON \`google-data-analysis\`.* TO 'crm'@'localhost';
GRANT ALL PRIVILEGES ON \`google-data-analysis_shadow\`.* TO 'crm'@'localhost';
FLUSH PRIVILEGES;
SELECT 'Databases and user created successfully' AS result;
"""

cmd = f'sudo mariadb -e "{sql_commands}"'
print(f">>> Creating databases and user...")
stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
out = stdout.read().decode()
err = stderr.read().decode()
if out:
    print(out)
if err:
    print(f"[STDERR] {err}")

# Verify
print(">>> Verifying...")
stdin, stdout, stderr = client.exec_command("sudo mariadb -e 'SHOW DATABASES;'", timeout=10)
print(stdout.read().decode())

# Check memory
stdin, stdout, stderr = client.exec_command("free -m | head -3", timeout=10)
print(stdout.read().decode())

client.close()
