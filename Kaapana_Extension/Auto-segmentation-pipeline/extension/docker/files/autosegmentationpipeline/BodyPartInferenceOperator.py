import logging
import os

import requests
from airflow.models import BaseOperator
from airflow.utils.decorators import apply_defaults


class BodyPartInferenceOperator(BaseOperator):
    """
    Operator to infer the body part from PACS metadata (SM studies) for a given MR/CT study.
    Replicates logic from server.js.
    """

    template_fields = ["study_uid"]

    @apply_defaults
    def __init__(
        self,
        study_uid,
        pacs_url="http://arc:8080/dcm4chee-arc",
        aet="DCM4CHEE",
        *args,
        **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.study_uid = study_uid
        # Allow environment overrides so this stays aligned with server.js defaults
        self.pacs_url = os.getenv("DCM4CHEE_BASE", pacs_url)
        self.aet = os.getenv("AET", aet)
        self.token = os.getenv("DCM4CHEE_TOKEN", None)
        self.logger = logging.getLogger(__name__)

    def execute(self, context):
        self.logger.info(
            f"Inferring body part for StudyUID: {self.study_uid} using PACS={self.pacs_url} AET={self.aet}"
        )
        
        # 1. Get PatientID from MR/CT Study
        patient_id = self.get_patient_id(self.study_uid)
        if not patient_id:
            self.logger.warning(f"Could not find PatientID for StudyUID: {self.study_uid}")
            return None

        # 2. Find SM studies for this patient
        sm_studies = self.find_sm_studies(patient_id)
        if not sm_studies:
            self.logger.warning(f"No SM studies found for PatientID: {patient_id}")
            return None

        # 3. Infer body part from SM studies
        body_part = self.infer_body_part_from_sm(sm_studies)
        
        if body_part:
            self.logger.info(f"Inferred body part: {body_part}")
            return body_part
        else:
            self.logger.warning("Could not infer body part from SM metadata.")
            return None

    def get_patient_id(self, study_uid):
        url = f"{self.pacs_url}/aets/{self.aet}/rs/studies"
        params = {
            "StudyInstanceUID": study_uid,
            "includefield": "00100020",  # PatientID
            "limit": 1,
        }
        try:
            resp = requests.get(url, params=params, headers=self._headers())
            resp.raise_for_status()
            data = resp.json()
            if data and len(data) > 0:
                return self.get_tag_value(data[0], "00100020")
        except Exception as e:
            self.logger.error(f"Error querying PACS for study: {e}")
        return None

    def find_sm_studies(self, patient_id):
        url = f"{self.pacs_url}/aets/{self.aet}/rs/studies"
        params = {
            "PatientID": patient_id,
            "Modality": "SM",
            "includefield": "all",
            "limit": 10,
        }
        try:
            resp = requests.get(url, params=params, headers=self._headers())
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            self.logger.error(f"Error querying PACS for SM studies: {e}")
        return []

    def infer_body_part_from_sm(self, sm_studies):
        # Prioritized check: Study -> Series -> Instance
        
        # 1. Check Study Level
        for study in sm_studies:
            body_part = self.check_item_tags(study)
            if body_part:
                return body_part

        # 2. Check Series Level
        for study in sm_studies:
            study_uid = self.get_tag_value(study, "0020000D")
            series_list = self.get_series(study_uid)
            for series in series_list:
                body_part = self.check_item_tags(series)
                if body_part:
                    return body_part
                
                # 3. Check Instance Level (first instance only)
                series_uid = self.get_tag_value(series, "0020000E")
                instances = self.get_instances(study_uid, series_uid)
                if instances and len(instances) > 0:
                    body_part = self.check_item_tags(instances[0])
                    if body_part:
                        return body_part
        return None

    def get_series(self, study_uid):
        url = f"{self.pacs_url}/aets/{self.aet}/rs/studies/{study_uid}/series"
        params = {"includefield": "all"}
        try:
            resp = requests.get(url, params=params, headers=self._headers())
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            self.logger.error(f"Error querying series: {e}")
        return []

    def get_instances(self, study_uid, series_uid):
        url = f"{self.pacs_url}/aets/{self.aet}/rs/studies/{study_uid}/series/{series_uid}/instances"
        params = {"includefield": "all", "limit": 1}
        try:
            resp = requests.get(url, params=params, headers=self._headers())
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            self.logger.error(f"Error querying instances: {e}")
        return []

    def check_item_tags(self, item):
        # Tags to check in order (from server.js)
        tags_to_check = [
            ("00180015", "value"), # BodyPartExamined
            ("00082218", "code_meaning"), # Anatomic Region Sequence
            ("00081084", "code_meaning"), # Admitting Diagnoses Code Seq
            ("00081030", "value"), # StudyDescription
            ("0008103E", "value"), # SeriesDescription
            ("00081080", "value"), # Admitting Diagnoses Description
            ("00321060", "value"), # Requested Procedure Description
            ("00321030", "value"), # Reason for Study
            ("00181030", "value"), # Protocol Name
        ]

        for tag, method in tags_to_check:
            val = None
            if method == "value":
                val = self.get_tag_value(item, tag)
            elif method == "code_meaning":
                val = self.get_code_meaning(item, tag)
            
            if val:
                normalized = self.normalize_body_part(val)
                if normalized:
                    return normalized
        return None

    def get_tag_value(self, item, tag):
        # DICOM JSON model: { "tag": { "vr": "XX", "Value": ["val"] } }
        if tag in item and "Value" in item[tag] and len(item[tag]["Value"]) > 0:
            return item[tag]["Value"][0]
        return None

    def get_code_meaning(self, item, seq_tag):
        # Extract CodeMeaning from a Sequence
        if seq_tag in item and "Value" in item[seq_tag]:
            for seq_item in item[seq_tag]["Value"]:
                if "00080104" in seq_item and "Value" in seq_item["00080104"]:
                     return seq_item["00080104"]["Value"][0]
        return None

    def normalize_body_part(self, value):
        if not value:
            return None
        
        v = str(value).lower()
        # Simple cleanup: keep only letters and spaces, collapse spaces
        import re
        simple = re.sub(r'[^a-z ]', ' ', v)
        simple = re.sub(r'\s+', ' ', simple).strip()

        BODY_PART_TO_TS_CANON = {
            "heart": "heart",
            "liver": "liver",
            "spleen": "spleen",
            "kidney": "kidney",
            "kidneys": "kidney",
            "lung": "lung",
            "lungs": "lung",
            "aorta": "aorta",
            "brain": "brain",
            "prostate": "prostate",
        }

        if simple in BODY_PART_TO_TS_CANON:
            return BODY_PART_TO_TS_CANON[simple]
        
        for key in BODY_PART_TO_TS_CANON:
            if key in simple:
                return BODY_PART_TO_TS_CANON[key]
        
        if "carcinoma of prostate" in simple or "prostate carcinoma" in simple:
            return "prostate"

        return None

    def _headers(self):
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers
