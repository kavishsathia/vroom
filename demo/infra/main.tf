terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# --- Enable required APIs ---

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
  ])

  project = var.project_id
  service = each.value

  disable_on_destroy = false
}

# --- Artifact Registry ---

resource "google_artifact_registry_repository" "pulse" {
  location      = var.region
  repository_id = "pulse"
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}

# --- Cloud Run ---

resource "google_cloud_run_v2_service" "pulse" {
  name     = "pulse-dashboard"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/pulse/dashboard:latest"

      ports {
        container_port = 8080
      }

      env {
        name  = "MAINTENANCE_MODE"
        value = "true"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_artifact_registry_repository.pulse,
  ]
}

# --- Make publicly accessible ---

resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.pulse.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Outputs ---

output "pulse_url" {
  value       = google_cloud_run_v2_service.pulse.uri
  description = "Pulse dashboard URL"
}
