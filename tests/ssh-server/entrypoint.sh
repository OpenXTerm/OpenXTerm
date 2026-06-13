#!/bin/sh
set -eu

TEST_PASSWORD="openxterm-test-password"
TEST_PASSPHRASE="openxterm-test-passphrase"

echo "openxterm:${TEST_PASSWORD}" | chpasswd
rm -rf /fixtures/* /home/openxterm/.ssh/authorized_keys

ssh-keygen -q -t ed25519 -N '' -C 'openxterm-integration' -f /fixtures/id_ed25519
printf '%s\n' "$TEST_PASSPHRASE" > /fixtures/passphrase

puttygen /fixtures/id_ed25519 -O private -o /fixtures/id_ed25519.ppk
puttygen /fixtures/id_ed25519 \
  -O private \
  -o /fixtures/id_ed25519-encrypted.ppk \
  --new-passphrase /fixtures/passphrase

cat /fixtures/id_ed25519.pub > /home/openxterm/.ssh/authorized_keys
chown -R openxterm:openxterm /home/openxterm/.ssh
chmod 600 /home/openxterm/.ssh/authorized_keys
chmod 644 /fixtures/id_ed25519 /fixtures/id_ed25519.ppk /fixtures/id_ed25519-encrypted.ppk

printf 'OpenXTerm SSH integration fixture\n' > /home/openxterm/integration-ready.txt
chown openxterm:openxterm /home/openxterm/integration-ready.txt

cat > /etc/ssh/sshd_config <<'EOF'
Port 22
ListenAddress 0.0.0.0
PasswordAuthentication yes
PubkeyAuthentication yes
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin no
AllowUsers openxterm
Subsystem sftp internal-sftp
PidFile /run/sshd.pid
LogLevel VERBOSE
EOF

ssh-keygen -A
touch /fixtures/ready

# Accept TCP and intentionally never speak SSH, allowing timeout behavior to be
# tested without relying on an external unroutable address.
socat TCP-LISTEN:2223,reuseaddr,fork SYSTEM:'sleep 30' &

exec /usr/sbin/sshd -D -e
