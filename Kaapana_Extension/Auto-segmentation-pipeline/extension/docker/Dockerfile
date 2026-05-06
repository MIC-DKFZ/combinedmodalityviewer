FROM local-only/base-installer:latest

LABEL IMAGE="dag-auto-segmentation-pipeline"
LABEL VERSION="0.5.1"
LABEL BUILD_IGNORE="False"

COPY files/dag_auto_segmentation_pipeline.py /kaapana/tmp/dags/
COPY files/autosegmentationpipeline/AutoSegmentationPipelineOperator.py /kaapana/tmp/dags/auto-segmentation-pipeline/
COPY files/pyradiomics/PyRadiomicsOperator.py /kaapana/tmp/dags/auto-segmentation-pipeline/
