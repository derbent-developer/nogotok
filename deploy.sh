#!/bin/sh
# Выкладка сайта на Cloudflare.
# Заодно переносит ключ GitHub из переменных сборки в рабочие секреты Worker'а
# и оставляет отчёт, чтобы было видно, что именно получила сборка.

REPORT="build-report.txt"

{
  echo "Отчёт сборки от $(date -u '+%Y-%m-%d %H:%M UTC')"
  echo
  echo "Имена переменных, доступных сборке:"
  env | cut -d= -f1 | sort | grep -v -E '^(npm_|NPM_|NODE_|_$|PATH$|PWD$|HOME$|SHLVL$)' | sed 's/^/  /'
  echo
} > "$REPORT"

if [ -n "$GITHUB_TOKEN" ]; then
  echo "GITHUB_TOKEN: найден, длина ${#GITHUB_TOKEN}" >> "$REPORT"
  if printf '%s' "$GITHUB_TOKEN" | npx wrangler secret put GITHUB_TOKEN; then
    echo "Секрет записан в рабочее окружение: да" >> "$REPORT"
  else
    echo "Секрет записать НЕ удалось" >> "$REPORT"
  fi
else
  echo "GITHUB_TOKEN: в переменных сборки не найден" >> "$REPORT"
fi

cat "$REPORT"
npx wrangler deploy
