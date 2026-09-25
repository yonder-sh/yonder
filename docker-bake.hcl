# Docker Bake targets for the shared build workflow
# (yonder-sh/shared-workflows: build-container-image), one call per target:
#   app    -> ghcr.io/yonder-sh/yonder         (web + migrate/setup-bucket/set-quota scripts)
#   collab -> ghcr.io/yonder-sh/yonder-collab  (Hocuspocus + the BullMQ worker)
# Both inherit the tags and labels docker/metadata-action writes into its bake
# file (the empty target below is its placeholder for local builds), and embed
# inline cache so the workflow's `cache-from` on `:latest` has layers to reuse.

target "docker-metadata-action" {}

target "_common" {
  inherits   = ["docker-metadata-action"]
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64"]
  cache-to   = ["type=inline"]
}

target "app" {
  inherits = ["_common"]
  target   = "app"
}

target "collab" {
  inherits = ["_common"]
  target   = "collab"
}

group "default" {
  targets = ["app"]
}
