from datetime import datetime, timezone
from backend.database import Base
from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey,
    Index, Integer, String, Text
)
from sqlalchemy.orm import relationship

STALE_DAYS = 3
DECAY_PER_DAY = 3


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    email = Column(String(256), unique=True, nullable=False, index=True)
    password_hash = Column(String(256), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    is_active = Column(Boolean, default=True, nullable=False)

    issues = relationship("Issue", back_populates="reporter", foreign_keys="Issue.reporter_id")
    validations = relationship("Validation", back_populates="user")


class Issue(Base):
    __tablename__ = "issues"

    id = Column(String(8), primary_key=True, index=True)
    lat = Column(Float, nullable=False, index=True)
    lon = Column(Float, nullable=False, index=True)
    category = Column(String(64), nullable=False, index=True)
    description = Column(Text, default="")
    reporter_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    reporter_name = Column(String(64), default="anonymous")
    confidence_score = Column(Float, default=65.0)
    num_reports = Column(Integer, default=1)
    num_confirmations = Column(Integer, default=0)
    num_dismissals = Column(Integer, default=0)
    is_active = Column(Boolean, default=True, nullable=False, index=True)
    reported_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    last_validated = Column(DateTime, nullable=True)

    reporter = relationship("User", back_populates="issues", foreign_keys=[reporter_id])
    validations = relationship("Validation", back_populates="issue")

    @property
    def effective_confidence(self) -> float:
        """Return confidence_score with staleness decay applied."""
        if self.last_validated is None:
            reference = self.reported_at
        else:
            reference = self.last_validated

        if reference is None:
            return float(self.confidence_score)

        # Make reference timezone-aware if it isn't already
        if reference.tzinfo is None:
            reference = reference.replace(tzinfo=timezone.utc)

        now = datetime.now(timezone.utc)
        age_days = (now - reference).total_seconds() / 86400.0
        decay = max(0.0, age_days - STALE_DAYS) * DECAY_PER_DAY
        score = float(self.confidence_score) - decay
        return max(0.0, min(100.0, score))

    @property
    def needs_revalidation(self) -> bool:
        """True when the issue has gone stale and its effective confidence has dropped."""
        if self.last_validated is None:
            reference = self.reported_at
        else:
            reference = self.last_validated

        if reference is None:
            return False

        if reference.tzinfo is None:
            reference = reference.replace(tzinfo=timezone.utc)

        age_days = (datetime.now(timezone.utc) - reference).total_seconds() / 86400.0
        return age_days > STALE_DAYS


class Validation(Base):
    __tablename__ = "validations"

    id = Column(Integer, primary_key=True, index=True)
    issue_id = Column(String(8), ForeignKey("issues.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    response = Column(String(16), nullable=False)  # "confirm" or "dismiss"
    validated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    issue = relationship("Issue", back_populates="validations")
    user = relationship("User", back_populates="validations")


Index("ix_issues_active_category_reported", Issue.is_active, Issue.category, Issue.reported_at)
Index("ix_issues_active_lat_lon", Issue.is_active, Issue.lat, Issue.lon)
Index("ix_validations_issue_user", Validation.issue_id, Validation.user_id, unique=False)
