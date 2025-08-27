# Broadway on Demand

## Overview

Broadway on Demand is the frontend web application for the CS 341 autograder at the University of Illinois.

This README will guide you through the setup and development process.

## Prerequisites

- Node.js (latest LTS version recommended)
- Yarn (v1.22.22 or newer)
- Git

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/cs341-illinois/on-demand
cd on-demand
```

### 2. Install Dependencies

```bash
yarn install
```

This will also automatically run the Prisma generate command to create the Prisma client.

### 3. Environment Setup

Create a `.env` file in the root of the project with the following variables:

```env
# Node environment (development, production, test)
NODE_ENV="development"

# Azure AD authentication settings
AZURE_CLIENT_ID="your-azure-client-id"
AZURE_CLIENT_SECRET="your-azure-client-secret"
AZURE_TENANT_ID="your-azure-tenant-id"

# Application settings
BASE_URL="/on-demand"
HOST="http://localhost:3000"
PORT=3000
# This is the URL jenkins will use to contact On-Demand. By default, it's the public-facing URL.
JENKINS_FACING_URL="http://host.docker.internal:4000/v2" 

# Security
COOKIE_SECRET="a-secure-random-string-at-least-32-characters"
GRADER_TOKEN="a-secure-random-string-at-least-32-characters"

# Database URL for Prisma
DATABASE_URL="postgresql://local:local@localhost:5432/broadway_on_demand"
```

All environment variables are validated using Zod schema validation at application startup. The required variables include:

- `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `AZURE_TENANT_ID` for Azure AD authentication
- `HOST` for server hosting configuration
- `GRADER_TOKEN` for secure grader communication
- `COOKIE_SECRET` (minimum 32 characters) for session security

### 4. Database Setup

Create and set up your database:

```bash
docker compose up -d
yarn prisma:migrate-dev
```

### 5. Start Development Server

```bash
yarn dev
```

This will start the development server with **UI hot reloading enabled** (changes to the API server currently require a manual restart). The application will be available at http://localhost:3000 (or the port you specified in your `.env` file).

## Available Scripts

- `yarn build` - Build both the server and client for production
- `yarn build:server` - Build only the server TypeScript files
- `yarn lint` - Run ESLint with automatic fixes where possible
- `yarn prettier` - Format code using Prettier
- `yarn dev` - Start the development server with hot reloading
- `yarn start:prod` - Start the production server (after building)
- `yarn prisma:generate` - Generate Prisma client
- `yarn prisma:studio` - Open Prisma Studio to view and edit database data
- `yarn setup` - Configure Git to use the blame ignore file

## Creating a course
Run the course creation CLI:
```
npx tsx src/scripts/createCourse.ts
```

## Deployment

To deploy the application to a production environment:

1. Build the application:

   ```bash
   yarn build
   ```

2. Start the production server:

   ```bash
   node dist/server.js
   ```

## Contributing

1. Create a feature branch from `main`
2. Make your changes
3. Run tests and ensure code quality with ESLint and Prettier
4. Submit a pull request

## License

This project is licensed under the BSD-3-Clause License.
