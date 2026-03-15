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
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "vpcaccess.googleapis.com",
  ])

  project = var.project_id
  service = each.value

  disable_on_destroy = false
}

# --- Artifact Registry (container images) ---

resource "google_artifact_registry_repository" "vroom" {
  location      = var.region
  repository_id = "vroom"
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}

# --- Cloud SQL (Postgres) ---

resource "google_sql_database_instance" "postgres" {
  name             = "vroom-db"
  database_version = "POSTGRES_15"
  region           = var.region

  settings {
    tier              = "db-f1-micro"
    availability_type = "ZONAL"

    ip_configuration {
      ipv4_enabled = false
      # Private IP not needed — Cloud Run uses Cloud SQL connector
    }
  }

  deletion_protection = false

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "vroom" {
  name     = "vroom"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "vroom" {
  name     = "vroom"
  instance = google_sql_database_instance.postgres.name
  password = var.db_password
}

# --- Cloud Run ---

resource "google_cloud_run_v2_service" "server" {
  name     = "vroom-server"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/vroom/server:latest"

      ports {
        container_port = 8765
      }

      env {
        name  = "DATABASE_URL"
        value = "postgresql://vroom:${var.db_password}@localhost/vroom?host=/cloudsql/${google_sql_database_instance.postgres.connection_name}"
      }

      env {
        name  = "GOOGLE_API_KEY"
        value = var.google_api_key
      }

      env {
        name  = "GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }

      env {
        name  = "GOOGLE_CLIENT_SECRET"
        value = var.google_client_secret
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.postgres.connection_name]
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_sql_database.vroom,
    google_sql_user.vroom,
  ]
}

# --- Make Cloud Run publicly accessible ---

resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.server.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Outputs ---

output "server_url" {
  value       = google_cloud_run_v2_service.server.uri
  description = "Cloud Run service URL"
}

output "cloud_sql_connection" {
  value       = google_sql_database_instance.postgres.connection_name
  description = "Cloud SQL connection name"
}
