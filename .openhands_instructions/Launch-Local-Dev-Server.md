Testing Workflow: After any code modifications, you must run npm test and verify that the service is running correctly on port 12000.

Use a local PostgreSQL instance for local dev, install and initialize before use.

`cd /workspace/project/Vox/.openhands_instructions && chmod +x ./local_setup.sh && ./local_setup.sh`

Launch the local dev service and keep it
`cd /workspace/project/Vox && PORT=12000 INIT_CODE=VOX-DEBUG-2024 DATABASE_URL=postgresql://vox:vox@127.0.0.1:5432/vox SESSION_SECRET=dev-secret npm run dev > /tmp/vox-dev.log 2>&1 & echo $!`
