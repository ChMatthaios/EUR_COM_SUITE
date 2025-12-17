# EUR_COM_SUITE — Banking Reports Suite (Frontend + FastAPI Backend)

A small “close-to-reality” banking-style app with:
- Role-based login (Customer / Employee / Admin)
- Customer-only portal (restricted to their own customer_id)
- Employee portal (browse customers and view latest reports)
- Reports Viewer with PDF-ready structured tables for JSON + XML
- SQLite database stored locally

---

## Project layout

> Note: in some setups you may have a nested folder structure like:
> - Outer folder (workspace): ...\EUR_COM_SUITE
> - Actual Git repo: ...\EUR_COM_SUITE\EUR_COM_SUITE (contains the .git folder)
>
> Always run Git commands from the folder that contains .git.

Typical structure:

EUR_COM_SUITE/
  backend/
    api_server.py
    auth_utils.py
    seed_users.py
    database.env
    sql/
      001_auth.sql
    database/
      MCH_DB.db
  frontend/
    login.html
    customer.html
    employee.html
    viewer.html
    app.js
    styles.css

---

## Requirements

- Python 3.10+ recommended
- pip installed
- SQLite (bundled with Python)
- Git (for pushing changes)

---

## First-time setup

### Backend dependencies

From the repo folder (the one that contains .git):

    python -m pip install -r backend/requirements.txt

If you don’t have a requirements.txt, install the typical dependencies used:

    python -m pip install fastapi uvicorn python-dotenv passlib[bcrypt] PyJWT

If you see bcrypt/passlib errors on very new Python versions:

    python -m pip install --upgrade passlib bcrypt

---

## Database configuration

The backend reads DB path from backend/database.env.

Example:

    EURCOM_DB_PATH=C:\Users\####\EUR_COM_SUITE\database\MCH_DB.db

(Every “####” is a real folder name on your PC.)

---

## Initialize / update DB schema

Run the SQL schema files against your SQLite DB (VS Code SQLite extension, DB Browser for SQLite, etc.).

At minimum, you need:
- ecs_users (login accounts)
- indexes on role / customer_id

Example schema file: backend/sql/001_auth.sql

---

## Seed login users

From repo root:

    python backend/seed_users.py

This inserts sample users (example):
- customer1 / Customer123!
- employee1 / Employee123!

---

## Run the app (local dev)

### Start backend (FastAPI)

From repo root:

    uvicorn backend.api_server:app --reload --host 127.0.0.1 --port 8000

Backend:
- http://127.0.0.1:8000

### Start frontend (static server)

From frontend/:

    cd frontend
    python -m http.server 5500

Frontend:
- http://127.0.0.1:5500/login.html

---

## Using the app

### Login + routing
After login, the frontend stores:
- ecs_token (bearer token)
- ecs_user (session info)

Based on role:
- Customer → customer portal + viewer limited to their own customer_id
- Employee/Admin → employee portal + viewer can select customers

### Reports Viewer (viewer.html)
The viewer:
- Loads the latest JSON/XML report
- Presents data in readable tables and key-value grids
- Supports Print / Save PDF with a print stylesheet that hides UI chrome
- Can download raw JSON / raw XML files

PDF naming rule:
- Customer: customer name (when available) or username
- Employee/Admin: customer_id + employee_id

---

## No-cache / versioned assets (frontend)

viewer.html loads:
- styles.css?v=<timestamp>
- app.js?v=<timestamp>

This prevents stale caching during development.

---

## Git workflow (VS Code)

### Install Git (first time)
If VS Code shows “Download Git for Windows”, install Git and restart VS Code.

Verify in VS Code Terminal:

    git --version

### Commit & Push (VS Code UI)
1) Source Control (Ctrl+Shift+G)
2) Review changes
3) Enter commit message
4) Commit
5) Push (or Sync Changes)

### Commit & Push (terminal)
From the actual repo folder (contains .git):

    git status
    git add .
    git commit -m "Your message"
    git push

If push complains about upstream branch:

    git push -u origin main

### Common issue: “not a git repository”
If you see:
    fatal: not a git repository (or any of the parent directories): .git

You are in the wrong folder. cd into the folder that contains .git.
In this project, it may be:
    ...\EUR_COM_SUITE\EUR_COM_SUITE

---

## Troubleshooting

- 401 Missing bearer token:
  Log in via login.html and ensure ecs_token exists in Local Storage.

- Backend error: wrong column name:
  Ensure SQL queries match actual DB columns (e.g., run_id not rpt_run_id).

- CORS issues:
  Backend should allow:
  http://127.0.0.1:5500 and http://localhost:5500