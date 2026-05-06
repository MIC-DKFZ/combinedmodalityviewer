# Docker Images

This directory contains the Docker images for the application.

## Download
The image tarball `nginx-SPLITVIEWER-images.tar` can be downloaded from the following link:
[https://hub.dkfz.de/f/108118972](https://hub.dkfz.de/f/108118972)

## Deployment Steps

### 1. Load Images
First, load the docker images from the tar file:

```bash
docker load -i nginx-SPLITVIEWER-images.tar
```

### 2. Start the Stack
Navigate to the directory containing the Docker Compose configuration:

```bash
cd ../Application_folder/SViewer2.0/Viewers/platform/app/.recipes/Nginx-Dcm4chee
```

Start the application stack:

```bash
docker compose up -d
```

### Notes
- **Architecture**: Ensure the target system architecture matches the build architecture (likely x86_64).
- **Volumes**: If you need to migrate existing data (Postgres, LDAP, etc.), you will need to backup and restore the respective volumes.
