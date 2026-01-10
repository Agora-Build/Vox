#! /bin/bash

sudo apt-get update
sudo apt-get install -y postgresql-17 postgresql-client-17
sudo service postgresql start

sudo -u postgres psql -c "CREATE ROLE vox WITH LOGIN PASSWORD 'vox';"
sudo -u postgres createdb -O vox vox

cd /workspace/project/Vox && npm install
cd /workspace/project/Vox && DATABASE_URL=postgresql://vox:vox@127.0.0.1:5432/vox npm run db:push
cd /workspace/project/Vox && psql postgresql://vox:vox@127.0.0.1:5432/vox -tc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
