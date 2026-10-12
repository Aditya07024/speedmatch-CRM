# SpeedMatch CRM

A lightweight, multi-company CRM built for momentum. Runs locally or self-hosted on Linux servers (e.g. Hostinger KVM 1 VPS) with PostgreSQL database and secure built-in email/password authentication.

## Quick Setup (Local Development)
```bash
pnpm install
cp .env.example .env        # edit DATABASE_URL and SESSION_SECRET
createdb speedmatch         # create PostgreSQL database
pnpm db:push                # apply database schema
pnpm dev                    # runs API on :8080 & Vite web app on :5173
```
Open http://localhost:5173 to start using SpeedMatch.

---

## Super Admin & Company Workspace Management

### 1. Default Super Admin Account
On startup, a default **Super Admin** account is automatically bootstrapped if no super admin exists:
- **Email**: `superadmin@speedmatch.com`
- **Password**: `superadmin123`

### 2. Super Admin Capabilities
When logged in as Super Admin (`/super-admin`):
- **Create Companies & Workspace Admin Accounts**: Create company workspaces with their Admin Email, Admin Name, Admin Password, and a custom **Initiation Code**.
- **Manage Initiation Codes**: View, edit, and update initiation codes for any company.
- **Reset Admin Passwords**: Instantly reset passwords for workspace admins.
- **Delete Workspaces**: Remove company workspaces and associated members.

### 3. Registration with Admin Initiation Code
- **User Registration Requirement**: Any new user registering on `/sign-up` **MUST enter a valid Admin Initiation Code** set by their workspace admin or super admin.
- **Security & Scope**: Registration is blocked if an invalid or empty initiation code is provided. Entering the correct initiation code grants active workspace membership under that company.

### 4. Workspace Admin Management (`/team`)
- Workspace Admins can view, edit, and copy their active **Workspace Initiation Code** on the **Team** page.
- Teammates can be invited via email or registered directly with the initiation code.

---

## Deploying to Hostinger KVM 1 VPS

### 1. Prerequisites on Hostinger KVM 1 (Ubuntu / Debian):
```bash
# Update server
sudo apt update && sudo apt upgrade -y

# Install Node.js 20+ & pnpm & PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs postgresql postgresql-contrib git
sudo npm install -g pnpm pm2
```

### 2. Database Setup on Hostinger VPS:
```bash
sudo -u postgres psql -c "CREATE USER speedmatch WITH PASSWORD 'your_secure_password';"
sudo -u postgres psql -c "CREATE DATABASE speedmatch OWNER speedmatch;"
```

### 3. Deploy Application Code:
```bash
# Clone repository or upload files to /var/www/speedmatch
cd /var/www/speedmatch

# Create production .env file
cat << 'EOF' > .env
DATABASE_URL=postgres://speedmatch:your_secure_password@localhost:5432/speedmatch
SESSION_SECRET=super_secret_random_key_here
PORT=8080
NODE_ENV=production
EOF

# Install dependencies and build production bundles
pnpm install
pnpm db:push
pnpm build
```

### 4. Run with PM2 (Production Process Manager):
```bash
# Start backend API (serves API and built React static app on PORT 8080)
pm2 start artifacts/api-server/dist/index.mjs --name speedmatch-crm

# Save PM2 process list to start on boot
pm2 save
pm2 startup
```

Now your CRM is live on your Hostinger KVM 1 server!

---

## Commands
| Command | What it does |
|---|---|
| `pnpm dev` | API + Web development server |
| `pnpm dev:api` / `pnpm dev:web` | Run backend API or web app individually |
| `pnpm db:push` | Sync Drizzle database schema with PostgreSQL |
| `pnpm build` | Typecheck & create production builds |
| `pnpm --filter @workspace/api-spec run codegen` | Re-generate API client & Zod schemas |

