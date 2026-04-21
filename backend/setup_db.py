"""
setup_db.py — One-time database initialisation script for SafeRoute.

Run this script once before starting the server for the first time,
or whenever you need to recreate the schema after a fresh install.

Prerequisites
-------------
1. Install PostgreSQL (https://www.postgresql.org/download/) and ensure
   the `psql` / `createdb` commands are on your PATH.

2. Create the database:

       createdb -U postgres saferoute

   Or inside a psql session:

       CREATE DATABASE saferoute;

3. Copy .env.example to .env and set DATABASE_URL, e.g.:

       DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/saferoute

4. Install Python dependencies:

       pip install -r requirements.txt

5. Run this script from the project root:

       python -m backend.setup_db

   (The -m flag ensures relative imports resolve correctly.)

What this script does
---------------------
- Reads DATABASE_URL from .env (via config.py).
- Imports all ORM models so their metadata is registered with SQLAlchemy.
- Calls Base.metadata.create_all() which issues CREATE TABLE IF NOT EXISTS
  for every model (users, issues, validations).
- Prints a confirmation for each table created.

Notes
-----
- This script is idempotent — running it multiple times is safe;
  existing tables and data are not touched.
- To reset the schema completely:
      DROP DATABASE saferoute;
      CREATE DATABASE saferoute;
  Then re-run this script.
"""

import sys

# Ensure the project root is on sys.path when run directly
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.config import DATABASE_URL
from backend.database import Base, create_tables, engine


def main():
    print("=" * 60)
    print("SafeRoute — Database Setup")
    print("=" * 60)
    print(f"Target database: {DATABASE_URL}\n")

    print("Creating tables …")
    create_tables()

    # List tables that now exist in the public schema
    from sqlalchemy import inspect
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    if tables:
        print(f"\nTables present in the database ({len(tables)}):")
        for t in sorted(tables):
            print(f"  ✓  {t}")
    else:
        print("No tables found — something may have gone wrong.")

    print("\nSetup complete. You can now start the server:")
    print("  uvicorn backend.main:app --reload")
    print("=" * 60)


if __name__ == "__main__":
    main()
