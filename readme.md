### The branches are as follow 

firstRelease is deployed is supabase 


RefactoringAPIwaddons is gonna be deployed with ?? intent to use mysql 
HTML → JavaScript → Node/Express API (HTTP port like 4000) → MySQL (port 3306)

-----------

# Krake Factory – AWS EC2 Deployment Notes

This document describes how the **Krake Factory Test & Inventory** app is deployed on an **AWS EC2 Ubuntu server**.

It’s written so someone else can pick it up, reproduce the setup, and maintain it.

---

## 0. High-Level Architecture

- **Frontend**: static HTML/CSS/JS
  - `public/factory-form.html` – create test runs
  - `public/records.html` – inventory / test run list
  - `public/board.html` – per-board details view
  - `public/labels.html` – QR image → PDF label tool
- **Backend (API)**: Node.js + Express
  - `server.js`
  - Serves static files from `public/`
  - API routes:
    - `GET  /api/ping`
    - `POST /api/test-run`
    - `GET  /api/test-runs`
    - `GET  /api/board/:serial`
    - `POST /api/labels/qr-image-pdf` (QR image → PDF label)
- **Database**: MySQL
  - DB name: `krake_factory`
  - User: `krake_user` @ `localhost`
- **Host**: AWS EC2, Ubuntu 22.04
- **Reverse proxy**: nginx (port 80 → Node on port 4000)
- **Process management**: `systemd` service `krake-factory`

Public URL (example):

```text
http://ec2-13-51-158-67.eu-north-1.compute.amazonaws.com/


------------------------------------------------------------------------------



1. Connect to the EC2 Server
1.1. SSH from local machine
ssh -i ~/Downloads/krake-key-ec2.pem \
    ubuntu@ec2-13-51-158-67.eu-north-1.compute.amazonaws.com
Prompt looks like:
ubuntu@ip-172-31-45-66:~$
2. Basic System Setup
From EC2 shell:
sudo apt update && sudo apt upgrade -y

# Tools
sudo apt install -y curl git
3. Node.js via nvm
3.1. Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
Verify:
command -v nvm   # should print "nvm"
3.2. Install Node
nvm install 22
node -v  # e.g. v22.21.1
npm  -v  # e.g. 10.9.4
Node path (used later in systemd unit):
nvm which 22
# example output:
# /home/ubuntu/.nvm/versions/node/v22.21.1/bin/node
4. MySQL Setup
4.1. Ensure MySQL is installed and running
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
sudo systemctl status mysql  # should be active (running)
4.2. Create DB and user
sudo mysql
Inside MySQL:
CREATE DATABASE IF NOT EXISTS krake_factory
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

DROP USER IF EXISTS 'krake_user'@'localhost';

CREATE USER 'krake_user'@'localhost'
  IDENTIFIED BY 'SomeStrongPassword!23';

GRANT ALL PRIVILEGES ON krake_factory.* TO 'krake_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
⚠️ For production, change SomeStrongPassword!23 to a strong, secret password and do not commit it to git.
5. Import Database Schema
5.1. Copy schema file from local machine → EC2
From local machine (Mac):
cd /Users/naghamkheir/Repos/testRecord_Inventory

scp -i ~/Downloads/krake-key-ec2.pem mySQLschema.txt \
    ubuntu@ec2-13-51-158-67.eu-north-1.compute.amazonaws.com:/home/ubuntu/
5.2. Import schema on EC2
On EC2:
mysql -u krake_user -p krake_factory < /home/ubuntu/mySQLschema.txt
# password: SomeStrongPassword!23
Verify tables:
mysql -u krake_user -p krake_factory -e "SHOW TABLES;"
# Expect:
# boards, powered_results, test_run_photos, test_runs, unpowered_results
6. Deploy the App Code
6.1. Copy project from local machine → EC2
From local machine:
cd /Users/naghamkheir/Repos

scp -i ~/Downloads/krake-key-ec2.pem -r testRecord_Inventory \
    ubuntu@ec2-13-51-158-67.eu-north-1.compute.amazonaws.com:/home/ubuntu/
6.2. Install dependencies on EC2
cd /home/ubuntu/testRecord_Inventory
npm install
7. Backend Configuration (server.js)
In /home/ubuntu/testRecord_Inventory/server.js the MySQL pool is configured as:
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: 3306,
  user: process.env.DB_USER || 'krake_user',
  password: process.env.DB_PASS || 'SomeStrongPassword!23',
  database: process.env.DB_NAME || 'krake_factory',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
Static files are served with:
app.use(express.static('public'));
Server:
const PORT = 4000;
app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
8. Frontend API URLs (same-origin)
In public/factory-form.html, public/records.html, and public/board.html:
// IMPORTANT: use same origin, not localhost:4000
const API_BASE = '';
Examples:
// factory-form.html
const res = await fetch(`${API_BASE}/api/test-run`, { ... });

// records.html
const res = await fetch(`${API_BASE}/api/test-runs`);

// board.html
const res = await fetch(`${API_BASE}/api/board/${encodeURIComponent(serial)}`);
This makes the browser call the same host that served the HTML (EC2).
9. Test API & DB from EC2
9.1. Start app manually (for debugging)
cd /home/ubuntu/testRecord_Inventory
npm start
# -> API server listening on http://localhost:4000
In another EC2 shell:
curl http://localhost:4000/api/ping
# {"ok":true,"db":1}
Test insert via curl:
curl -X POST http://localhost:4000/api/test-run \
  -H "Content-Type: application/json" \
  -d '{
    "board": {
      "serial_number": "KRK-AWS-0001",
      "hardware_rev": "RevA",
      "pcb_rev": "PCB1",
      "batch": "AWS-TEST",
      "date_assembled": "2025-12-20",
      "assembled_by": "Nagham",
      "country": "Lebanon",
      "lab": "Remote",
      "status": "IN_TEST",
      "gdt_key": null,
      "gdt_url": null,
      "notes": "Inserted via curl"
    },
    "test_run": {
      "test_location": "AWS-EC2",
      "tester": "Nagham",
      "firmware_version": "1.0.0",
      "test_fixture_version": "FT-01",
      "overall_result": "PASS",
      "comments": "Smoke test from curl"
    },
    "unpowered": null,
    "powered": null
  }'
Check count in DB:
mysql -u krake_user -p krake_factory -e "SELECT COUNT(*) AS runs FROM test_runs;"
10. nginx Reverse Proxy (Port 80 → 4000)
10.1. Install nginx
sudo apt install -y nginx
sudo systemctl enable --now nginx
sudo systemctl status nginx
10.2. Site config
Create /etc/nginx/sites-available/krake-factory:
sudo nano /etc/nginx/sites-available/krake-factory
Content:
server {
    listen 80;
    server_name ec2-13-51-158-67.eu-north-1.compute.amazonaws.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
Enable it and disable default:
sudo ln -sf /etc/nginx/sites-available/krake-factory \
            /etc/nginx/sites-enabled/krake-factory

sudo rm /etc/nginx/sites-enabled/default 2>/dev/null || true
Test and reload:
sudo nginx -t
sudo systemctl restart nginx
10.3. AWS Security Group
On the EC2 instance security group, inbound rules must include:
HTTP – port 80 – source 0.0.0.0/0
SSH – port 22 – source My IP (or restricted range)
11. Systemd Service (Keep Node Running)
11.1. Create service
sudo nano /etc/systemd/system/krake-factory.service
Content (update NODE_PATH to match nvm which 22):
[Unit]
Description=Krake Factory Node API
After=network.target mysql.service

[Service]
WorkingDirectory=/home/ubuntu/testRecord_Inventory
ExecStart=/home/ubuntu/.nvm/versions/node/v22.21.1/bin/node server.js

Restart=always
RestartSec=5

Environment=NODE_ENV=production
User=ubuntu
Group=ubuntu

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
11.2. Enable & start
sudo systemctl daemon-reload
sudo systemctl enable krake-factory
sudo systemctl start  krake-factory
sudo systemctl status krake-factory
You should see Active: active (running).
11.3. Managing the service
Check status:
sudo systemctl status krake-factory
Restart after code changes:
sudo systemctl restart krake-factory
View logs:
sudo journalctl -u krake-factory -f
No need to run npm start manually once systemd is configured.
12. Verifying End-to-End
From a browser (anywhere):
Open test form:
http://ec2-13-51-158-67.eu-north-1.compute.amazonaws.com/factory-form.html
Submit a test run with a unique serial, e.g. KRK-AWS-UI-001.
Check inventory:
http://ec2-13-51-158-67.eu-north-1.compute.amazonaws.com/records.html
Clear filters (serial empty, location = All, result = All).
Click Reload.
The new run should appear for all users.
Board details:
Click the serial in the inventory table to open board.html?serial=....
QR label:
http://ec2-13-51-158-67.eu-north-1.compute.amazonaws.com/labels.html
Upload a QR image.
Enter a serial and optional caption.
Download/print the generated PDF label.
13. Troubleshooting Cheatsheet
502 Bad Gateway (nginx)
Check Node:
sudo systemctl status krake-factory
curl http://localhost:4000/api/ping
Check nginx:
curl http://localhost/api/ping
sudo nginx -t
sudo systemctl restart nginx
Form submits but DB count doesn’t change
Ensure API_BASE = '' in factory-form.html.
In browser DevTools → Network → check POST /api/test-run:
URL must be http://ec2-.../api/test-run
Status 200
MySQL access denied
Recreate user:
sudo mysql
DROP USER IF EXISTS 'krake_user'@'localhost';
CREATE USER 'krake_user'@'localhost'
  IDENTIFIED BY 'SomeStrongPassword!23';
GRANT ALL PRIVILEGES ON krake_factory.* TO 'krake_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
This document should be enough for someone else to:
Understand what’s deployed
Recreate the environment
Restart / debug the service
Safely update code and DB.

::contentReference[oaicite:0]{index=0}