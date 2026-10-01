#!/bin/sh
# board.html is the artifact-ready source (no doctype/head/body wrapper).
# This wraps it into a standalone file you can open from disk.
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<style>html{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%%}[hidden]{display:none!important}</style>\n'
  cat board.html
  printf '\n</body>\n</html>\n'
} > warplan.html
echo "built warplan.html"
