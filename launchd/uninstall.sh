#!/bin/sh
PREFIX=${PREFIX:-com.$(whoami).warplan}
for n in comms-morning today today-refresh recap comms-poll; do
  launchctl bootout "gui/$(id -u)/$PREFIX-$n" 2>/dev/null && echo "stopped $n"
  rm -f "$HOME/Library/LaunchAgents/$PREFIX-$n.plist"
done
