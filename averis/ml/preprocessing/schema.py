"""Feature definitions — the single source of truth for both runtimes.

Everything here is exported into the model artifact, so the TypeScript
inference code validates against exactly the ranges the model was trained
under. A feature cannot drift between training and serving without the
artifact changing, which is the only failure mode that matters here: a model
scoring a value it never saw during training will produce a confident number
that means nothing.

`plausible` is a clinical sanity range, not the training range. It exists to
reject transcription errors — a glucose of 1600 is a misplaced decimal, and
scoring it would hand a patient a fabricated 99% risk.
"""

from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class Feature:
    name: str
    """Machine name. Matches the artifact and the TypeScript feature keys."""

    label: str
    """What a patient sees. Written for a person, not a data dictionary."""

    unit: str | None
    """Displayed after the value. None for unitless scores and flags."""

    plausible: tuple[float, float]
    """Reject outside this. A clinical sanity range, not the training range."""

    higher_is_riskier: bool | None
    """
    Direction a clinician would expect. Used only to flag when the fitted
    coefficient disagrees — which is a signal the model learned an artefact of
    the cohort rather than physiology, and is worth surfacing at training time
    rather than discovering in production.
    """

    derivable: bool
    """
    Whether AVERIS can extract this from a patient's own confirmed records.
    Features that are not derivable fall back to the training mean, and every
    such substitution lowers the reported confidence.
    """

    def to_dict(self) -> dict:
        data = asdict(self)
        data["plausible"] = list(self.plausible)
        return data


# --------------------------------------------------------------- diabetes
#
# Pima Indians Diabetes. Note what is absent: there is no sex feature, because
# every subject in this cohort is a woman of Pima heritage aged 21 or over.
# Adding a sex input the model never saw would be inventing a signal.

DIABETES_FEATURES: list[Feature] = [
    Feature("pregnancies", "Number of pregnancies", None, (0, 20), True, True),
    Feature("glucose", "Plasma glucose", "mg/dL", (40, 400), True, True),
    Feature("blood_pressure", "Diastolic blood pressure", "mm Hg", (30, 160), True, True),
    Feature("skin_thickness", "Triceps skinfold thickness", "mm", (5, 110), True, False),
    Feature("insulin", "Serum insulin", "mu U/mL", (10, 900), True, True),
    Feature("bmi", "Body mass index", "kg/m²", (12, 70), True, True),
    Feature("diabetes_pedigree", "Family history score", None, (0.05, 2.5), True, False),
    Feature("age", "Age", "years", (18, 110), True, True),
]

# --------------------------------------------------------- cardiovascular
#
# Cleveland Heart Disease. The brief asked for BMI and smoking history; the
# Cleveland cohort records neither, so they are not here. Fabricating those two
# columns would produce a model that appears to account for smoking and does
# not — which is worse than a model that visibly does not ask.

CARDIO_FEATURES: list[Feature] = [
    Feature("age", "Age", "years", (18, 110), True, True),
    Feature("sex", "Sex recorded at birth", None, (0, 1), None, True),
    # Cleveland encodes this 1-4 (typical angina, atypical angina,
    # non-anginal pain, asymptomatic) — not 0-3. Declaring 0-3 made the
    # API reject a legitimate value of 4 and put the imputed training mean
    # outside its own plausible range.
    Feature("chest_pain_type", "Chest pain type", None, (1, 4), None, False),
    Feature("resting_bp", "Resting systolic blood pressure", "mm Hg", (70, 260), True, True),
    Feature("cholesterol", "Serum cholesterol", "mg/dL", (80, 700), True, True),
    Feature("fasting_blood_sugar", "Fasting blood sugar over 120 mg/dL", None, (0, 1), True, True),
    Feature("max_heart_rate", "Maximum heart rate achieved", "bpm", (60, 230), False, False),
    Feature("exercise_angina", "Chest pain brought on by exercise", None, (0, 1), True, False),
    Feature("st_depression", "ST depression induced by exercise", None, (0, 7), True, False),
]


SCHEMAS: dict[str, list[Feature]] = {
    "diabetes": DIABETES_FEATURES,
    "cardiovascular": CARDIO_FEATURES,
}


def feature_names(model: str) -> list[str]:
    return [f.name for f in SCHEMAS[model]]
