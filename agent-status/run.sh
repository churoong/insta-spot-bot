set +e
npx next build > build.log 2>&1 || { echo "::notice title=build::$(tail -c 1500 build.log | tr '\n' ' ')"; exit 0; }
npx next start -p 3123 > srv.log 2>&1 &
sleep 8
code=$(curl -s -o page.html -w '%{http_code}' localhost:3123/)
sleep 2
echo "::notice title=local::code=$code $(grep -v '^\s*$' srv.log | tail -c 3000 | tr '\n' ' ')"
