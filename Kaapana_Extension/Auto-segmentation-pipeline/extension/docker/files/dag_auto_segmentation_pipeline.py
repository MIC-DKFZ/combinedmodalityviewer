from datetime import timedelta

from airflow.models import DAG
from airflow.utils.dates import days_ago

from kaapana.operators.DcmConverterOperator import DcmConverterOperator
from kaapana.operators.DcmSendOperator import DcmSendOperator
from kaapana.operators.Itk2DcmSegOperator import Itk2DcmSegOperator
from kaapana.operators.GetInputOperator import GetInputOperator
from kaapana.operators.LocalWorkflowCleanerOperator import LocalWorkflowCleanerOperator
from autosegmentationpipeline.AutoSegmentationPipelineOperator import AutoSegmentationPipelineOperator
from autosegmentationpipeline.BodyPartInferenceOperator import BodyPartInferenceOperator
from kaapana.operators.GetZenodoModelOperator import GetZenodoModelOperator
from kaapana.operators.MinioOperator import MinioOperator
from kaapana.operators.MergeMasksOperator import MergeMasksOperator
from pyradiomics.PyRadiomicsOperator import PyRadiomicsOperator

max_active_runs = 10
concurrency = max_active_runs * 3
alg_name = "AutoSegmentationPipeline"

ui_forms = {
    "documentation_form": {
        "path": "/user_guide/extensions.html#totalsegmentator",
    },
    "publication_form": {
        "type": "object",
        "properties": {
            "title": {
                "title": "Title",
                "default": "Bridging Radiology and Pathology: A DICOM-Based Framework for Multimodal Mapping and Integrated Visualization",
                "type": "string",
                "readOnly": True,
            },
            "authors": {
                "title": "Authors",
                "default": "Rijhwani N.P., Brinker T.J., Neher P., Nolden M., Maier-Hein K., Wies C., Fischer M.",
                "type": "string",
                "readOnly": True,
            },
            "link": {
                "title": "DOI",
                "default": "to be updated soon",
                "description": "DOI",
                "type": "string",
                "readOnly": True,
            },
            "confirmation": {
                "title": "Accept",
                "default": False,
                "type": "boolean",
                "readOnly": False,
                "required": True,
            },
        },
    },
    "workflow_form": {
        "type": "object",
        "properties": {
            "input": {
                "title": "Input",
                "default": "CT",
                "description": "Input-data modality",
                "type": "string",
                "readOnly": True,
            },
            "single_execution": {
                "title": "single execution",
                "description": "Should each series be processed separately?",
                "type": "boolean",
                "default": True,
                "readOnly": True,
            },
        },
    },
}

args = {
    "ui_visible": True,
    "ui_forms": ui_forms,
    "owner": "kaapana",
    "start_date": days_ago(0),
    "retries": 0,
    "retry_delay": timedelta(seconds=60),
}

dag = DAG(
    dag_id="auto-segmentation-pipeline",
    default_args=args,
    concurrency=concurrency,
    max_active_runs=max_active_runs,
    schedule_interval=None,
)

# Download all models at once
get_total_segmentator_model = GetZenodoModelOperator(
    dag=dag,
    model_dir="/models/total_segmentator/nnUNet",
    task_ids="Task251_TotalSegmentator_part1_organs_1139subj,Task252_TotalSegmentator_part2_vertebrae_1139subj,Task253_TotalSegmentator_part3_cardiac_1139subj,Task254_TotalSegmentator_part4_muscles_1139subj,Task255_TotalSegmentator_part5_ribs_1139subj,Task256_TotalSegmentator_3mm_1139subj,Task258_lung_vessels_248subj,Task150_icb_v0,Task260_hip_implant_71subj,Task503_cardiac_motion,Task269_Body_extrem_6mm_1200subj,Task273_Body_extrem_1259subj,Task315_thoraxCT",
)

get_input = GetInputOperator(dag=dag, parallel_downloads=5, check_modality=True)

# Body Part Inference
infer_body_part = BodyPartInferenceOperator(
    dag=dag,
    task_id="infer_body_part",
    study_uid="{{ dag_run.conf['study_uid'] }}",
)

dcm2nifti = DcmConverterOperator(
    dag=dag,
    input_operator=get_input,
    output_format="nii.gz",
)

# Dynamic task execution based on body_part selection
# Use inferred body part if available, otherwise fallback to form input or 'total'
body_part_expression = (
    "{{ task_instance.xcom_pull(task_ids='infer_body_part') or dag_run.conf.get('body_part', 'total') }}"
)

total_segmentator = AutoSegmentationPipelineOperator(
    dag=dag,
    task=body_part_expression,
    input_operator=dcm2nifti,
    fast=True, # Defaulting to fast as requested
    env_vars={"BODY_PART": body_part_expression}
)

combine_masks = MergeMasksOperator(
    dag=dag,
    input_operator=total_segmentator,
    parallel_id="combined",
)

nrrd2dcmSeg_multi = Itk2DcmSegOperator(
    dag=dag,
    input_operator=get_input,
    segmentation_operator=combine_masks,
    input_type="multi_label_seg",
    multi_label_seg_name=alg_name,
    multi_label_seg_info_json="seg_info.json",
    skip_empty_slices=True,
    parallel_id="combined",
    alg_name=f"{alg_name}-combined",
)

dcmseg_send = DcmSendOperator(
    dag=dag,
    input_operator=nrrd2dcmSeg_multi,
    parallel_id="combined",
)

pyradiomics = PyRadiomicsOperator(
    dag=dag,
    input_operator=dcm2nifti,
    segmentation_operator=total_segmentator,
    parallel_id="combined",
)

put_to_minio = MinioOperator(
    dag=dag,
    action="put",
    minio_prefix="radiomics-totalsegmentator",
    batch_input_operators=[pyradiomics],
    whitelisted_file_extensions=[".json"],
    trigger_rule="none_failed_min_one_success",
)

clean = LocalWorkflowCleanerOperator(
    dag=dag,
    clean_workflow_dir=True,
    trigger_rule="none_failed",
)

get_total_segmentator_model >> total_segmentator

(
    get_input
    >> infer_body_part
    >> dcm2nifti
    >> total_segmentator
    >> combine_masks
    >> nrrd2dcmSeg_multi
    >> dcmseg_send
    >> clean
)

total_segmentator >> pyradiomics >> put_to_minio >> clean
