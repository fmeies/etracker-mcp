{{- define "etracker-mcp.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "etracker-mcp.labels" -}}
app.kubernetes.io/name: etracker-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "etracker-mcp.selectorLabels" -}}
app.kubernetes.io/name: etracker-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
