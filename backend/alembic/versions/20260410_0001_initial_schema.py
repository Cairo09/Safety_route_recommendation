"""Initial schema

Revision ID: 20260410_0001
Revises:
Create Date: 2026-04-10 15:30:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20260410_0001'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'users',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('username', sa.String(length=64), nullable=False),
        sa.Column('email', sa.String(length=256), nullable=False),
        sa.Column('password_hash', sa.String(length=256), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_users_id', 'users', ['id'], unique=False)
    op.create_index('ix_users_username', 'users', ['username'], unique=True)
    op.create_index('ix_users_email', 'users', ['email'], unique=True)

    op.create_table(
        'issues',
        sa.Column('id', sa.String(length=8), nullable=False),
        sa.Column('lat', sa.Float(), nullable=False),
        sa.Column('lon', sa.Float(), nullable=False),
        sa.Column('category', sa.String(length=64), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('reporter_id', sa.Integer(), nullable=True),
        sa.Column('reporter_name', sa.String(length=64), nullable=True),
        sa.Column('confidence_score', sa.Float(), nullable=True),
        sa.Column('num_reports', sa.Integer(), nullable=True),
        sa.Column('num_confirmations', sa.Integer(), nullable=True),
        sa.Column('num_dismissals', sa.Integer(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('reported_at', sa.DateTime(), nullable=True),
        sa.Column('last_validated', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['reporter_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_issues_id', 'issues', ['id'], unique=False)
    op.create_index('ix_issues_lat', 'issues', ['lat'], unique=False)
    op.create_index('ix_issues_lon', 'issues', ['lon'], unique=False)
    op.create_index('ix_issues_category', 'issues', ['category'], unique=False)
    op.create_index('ix_issues_is_active', 'issues', ['is_active'], unique=False)
    op.create_index('ix_issues_reported_at', 'issues', ['reported_at'], unique=False)
    op.create_index('ix_issues_active_category_reported', 'issues', ['is_active', 'category', 'reported_at'], unique=False)
    op.create_index('ix_issues_active_lat_lon', 'issues', ['is_active', 'lat', 'lon'], unique=False)

    op.create_table(
        'validations',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('issue_id', sa.String(length=8), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('response', sa.String(length=16), nullable=False),
        sa.Column('validated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['issue_id'], ['issues.id'], ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_validations_id', 'validations', ['id'], unique=False)
    op.create_index('ix_validations_issue_id', 'validations', ['issue_id'], unique=False)
    op.create_index('ix_validations_issue_user', 'validations', ['issue_id', 'user_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_validations_issue_user', table_name='validations')
    op.drop_index('ix_validations_issue_id', table_name='validations')
    op.drop_index('ix_validations_id', table_name='validations')
    op.drop_table('validations')

    op.drop_index('ix_issues_active_lat_lon', table_name='issues')
    op.drop_index('ix_issues_active_category_reported', table_name='issues')
    op.drop_index('ix_issues_reported_at', table_name='issues')
    op.drop_index('ix_issues_is_active', table_name='issues')
    op.drop_index('ix_issues_category', table_name='issues')
    op.drop_index('ix_issues_lon', table_name='issues')
    op.drop_index('ix_issues_lat', table_name='issues')
    op.drop_index('ix_issues_id', table_name='issues')
    op.drop_table('issues')

    op.drop_index('ix_users_email', table_name='users')
    op.drop_index('ix_users_username', table_name='users')
    op.drop_index('ix_users_id', table_name='users')
    op.drop_table('users')
