FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-server \
        putty-tools \
        socat \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash openxterm \
    && mkdir -p /run/sshd /home/openxterm/.ssh \
    && chmod 700 /home/openxterm/.ssh

COPY entrypoint.sh /usr/local/bin/openxterm-ssh-test-entrypoint
RUN chmod 755 /usr/local/bin/openxterm-ssh-test-entrypoint

EXPOSE 22 2223

ENTRYPOINT ["/usr/local/bin/openxterm-ssh-test-entrypoint"]
