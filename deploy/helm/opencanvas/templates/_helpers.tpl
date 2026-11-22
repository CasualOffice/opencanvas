{{- /*
SPDX-License-Identifier: Apache-2.0
Copyright 2026 CasualOffice
*/ -}}

{{- define "opencanvas.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "opencanvas.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "opencanvas.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "opencanvas.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "opencanvas.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opencanvas.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
{{- end }}

{{- define "opencanvas.gotenbergLabels" -}}
app.kubernetes.io/name: {{ include "opencanvas.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: gotenberg
{{- end }}

{{- define "opencanvas.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "opencanvas.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The Secret every key of which becomes an env var. */}}
{{- define "opencanvas.secretName" -}}
{{- default (include "opencanvas.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{- define "opencanvas.hostsConfigMap" -}}
{{- default (printf "%s-hosts" (include "opencanvas.fullname" .)) .Values.hosts.existingConfigMap }}
{{- end }}

{{/* SQLite unless a MySQL/MariaDB URL is configured. */}}
{{- define "opencanvas.sqlite" -}}
{{- if or .Values.database.url .Values.database.existingSecret }}false{{ else }}true{{ end }}
{{- end }}

{{- define "opencanvas.cluster" -}}
{{- if or .Values.redis.url .Values.redis.existingSecret }}true{{ else }}false{{ end }}
{{- end }}

{{- define "opencanvas.pdfRenderer" -}}
{{- if .Values.gotenberg.externalUrl -}}
gotenberg:{{ .Values.gotenberg.externalUrl }}
{{- else if and .Values.gotenberg.enabled (eq .Values.gotenberg.mode "sidecar") -}}
gotenberg:http://127.0.0.1:3000
{{- else if .Values.gotenberg.enabled -}}
gotenberg:http://{{ include "opencanvas.fullname" . }}-gotenberg:3000
{{- end }}
{{- end }}

{{/* Fails rendering on configurations that cannot work. */}}
{{- define "opencanvas.validate" -}}
{{- $sqlite := eq (include "opencanvas.sqlite" .) "true" }}
{{- if and $sqlite (or (gt (int .Values.replicaCount) 1) .Values.autoscaling.enabled) }}
{{- fail "SQLite (no database.url) supports exactly one replica: set replicaCount: 1 and autoscaling.enabled: false, or configure database.url + redis.url" }}
{{- end }}
{{- if and $sqlite (eq (include "opencanvas.cluster" .) "true") }}
{{- fail "redis.url (cluster mode) needs database.url: the server refuses SQLite with REDIS_URL (ADR-004)" }}
{{- end }}
{{- if and (not $sqlite) (ne (include "opencanvas.cluster" .) "true") (or (gt (int .Values.replicaCount) 1) .Values.autoscaling.enabled) }}
{{- fail "more than one replica needs redis.url for room ownership (ADR-006)" }}
{{- end }}
{{- if and (not .Values.dev) (not .Values.secrets.existingSecret) (not .Values.secrets.kek) }}
{{- fail "secrets.kek is required (openssl rand -base64 32), or secrets.existingSecret with OC_KEK, or dev: true" }}
{{- end }}
{{- if not (has .Values.gotenberg.mode (list "deployment" "sidecar")) }}
{{- fail "gotenberg.mode must be deployment or sidecar" }}
{{- end }}
{{- end }}
