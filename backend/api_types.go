package main

// These named HTTP types preserve the frozen JSON contract.
type ImportRequest struct {
	Source string `json:"source"`
	CSV    string `json:"csv"`
}
type ReviewRequest struct {
	Fingerprint string `json:"fingerprint"`
	Note        string `json:"note"`
}
type ConfigResponse struct {
	Investigator    string `json:"investigator"`
	Storage         string `json:"storage"`
	RedisConfigured bool   `json:"redis_configured"`
	KafkaConfigured bool   `json:"kafka_configured"`
}
type StatusResponse struct {
	Status string `json:"status"`
}
type ErrorResponse struct {
	Error string `json:"error"`
}
