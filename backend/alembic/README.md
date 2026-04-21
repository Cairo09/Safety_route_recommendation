# Alembic Migrations (SafeRoute)

## Setup
1. Install dependencies:
   `pip install -r backend/requirements.txt`
2. Ensure `DATABASE_URL` in `backend/.env` points to the target database.

## Common commands
1. Create a new migration:
   `python -m alembic revision -m "your_message"`
2. Autogenerate from SQLAlchemy models:
   `python -m alembic revision --autogenerate -m "your_message"`
3. Apply latest migrations:
   `python -m alembic upgrade head`
4. Show current migration:
   `python -m alembic current`
5. Show migration history:
   `python -m alembic history`
6. Roll back one migration:
   `python -m alembic downgrade -1`

## Notes
1. `backend/main.py` supports `AUTO_CREATE_TABLES=1` for quick local prototyping.
2. For production/staging, keep `AUTO_CREATE_TABLES=0` and use Alembic upgrades.
