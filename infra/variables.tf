variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "gen-lang-client-0869569528"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "google_api_key" {
  description = "Google Gemini API key"
  type        = string
  sensitive   = true
}

variable "google_client_id" {
  description = "Google OAuth client ID"
  type        = string
  sensitive   = true
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "Cloud SQL Postgres password"
  type        = string
  sensitive   = true
}
