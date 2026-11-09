# How a value goes into a systemd unit, as systemd reads it back. Sourced by
# every script that writes a unit (install-service.sh, follow-channel.sh,
# follow-latest.sh, privacy-sync.sh), never run on its own: one copy, so a fix
# here reaches them all (review of HB-0546: privacy-sync.sh still wrote its
# folder unquoted after the others were fixed).
#
# Inside a quoted word (Environment="NAME=…", or ExecStart="…"): a backslash or
# a quote escaped, and % doubled (systemd reads %h and the like there). Not
# quoted, a space in the value split it (audit #044, HB-0546).
systemd_quoted() { printf '%s' "$1" | sed -e 's/[\\"]/\\&/g' -e 's/%/%%/g'; }
# The same for one of ExecStart's arguments (not the program, which is taken as
# written): a $ doubled too, since systemd expands ${NAME} there (audit,
# 2026-10-29: a folder named install-%q, or with a $ in it).
systemd_arg() { systemd_quoted "$1" | sed -e 's/\$/$$/g'; }
# A path setting that is not quoted (WorkingDirectory=, EnvironmentFile=): % doubled.
systemd_path() { printf '%s' "$1" | sed -e 's/%/%%/g'; }
