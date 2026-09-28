package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// Configuration is validated before opening storage or contacting services.
// Diagnostics intentionally omit all connection strings and token values.
type runtimeConfig struct {
	command                                       string
	check, checkModel                             bool
	addr, token, databaseURL, redisURL, brokers   string
	statePath, webDir, sampleDir, modelURL, model string
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func loadRuntimeConfig(args []string, get func(string) string) (runtimeConfig, error) {
	value := func(key, fallback string) string {
		if v := get(key); v != "" {
			return v
		}
		return fallback
	}
	c := runtimeConfig{
		command: "serve",
		addr:    value("ADDR", "127.0.0.1:8080"), token: get("API_TOKEN"),
		databaseURL: get("DATABASE_URL"), redisURL: get("REDIS_URL"), brokers: get("KAFKA_BROKERS"),
		statePath: value("STATE_PATH", "data/state.json"),
		webDir:    value("WEB_DIR", "../web/dist"), sampleDir: value("SAMPLE_DIR", "../samples"),
		modelURL: get("OLLAMA_URL"), model: value("OLLAMA_MODEL", "qwen3:4b-instruct-2507-q4_K_M"),
	}
	switch {
	case len(args) == 0:
	case len(args) == 1 && (args[0] == "serve" || args[0] == "worker"):
		c.command = args[0]
	case len(args) >= 1 && len(args) <= 2 && args[0] == "check":
		c.check = true
		if len(args) == 2 {
			switch args[1] {
			case "--model":
				c.checkModel = true
			case "worker":
				c.command = "worker"
			default:
				return c, errors.New("usage: clearledger [serve|worker|check [--model|worker]]")
			}
		}
	default:
		return c, errors.New("usage: clearledger [serve|worker|check [--model|worker]]")
	}
	if c.command == "serve" {
		host, err := addressHost(c.addr, true)
		if err != nil {
			return c, errors.New("ADDR must be a host:port with a port from 1 to 65535")
		}
		local := host == "localhost" || net.ParseIP(host).IsLoopback()
		if !local && len(c.token) < 24 {
			return c, errors.New("non-loopback ADDR requires API_TOKEN of at least 24 characters")
		}
	}
	for _, r := range c.token {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return c, errors.New("API_TOKEN must not contain whitespace or control characters")
		}
	}
	if c.databaseURL != "" {
		if _, err := pgxpool.ParseConfig(c.databaseURL); err != nil {
			return c, errors.New("DATABASE_URL is invalid; use a PostgreSQL connection string")
		}
	}
	if c.redisURL != "" {
		if _, err := redis.ParseURL(c.redisURL); err != nil {
			return c, errors.New("REDIS_URL is invalid; use redis:// or rediss:// with a database number")
		}
	}
	if c.brokers != "" {
		if c.databaseURL == "" {
			return c, errors.New("KAFKA_BROKERS requires DATABASE_URL for durable event delivery")
		}
		parts := strings.Split(c.brokers, ",")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
			if _, err := addressHost(parts[i], false); err != nil {
				return c, errors.New("KAFKA_BROKERS must contain comma-separated host:port addresses")
			}
		}
		c.brokers = strings.Join(parts, ",")
	}
	if c.command == "worker" && (c.databaseURL == "" || c.brokers == "") {
		return c, errors.New("worker requires DATABASE_URL and KAFKA_BROKERS; run serve for the local app")
	}
	if c.modelURL != "" {
		if err := validateModelURL(c.modelURL); err != nil {
			return c, err
		}
		c.modelURL = strings.TrimRight(c.modelURL, "/")
		if !modelNamePattern.MatchString(c.model) {
			return c, errors.New("OLLAMA_MODEL must be a model name/tag of 1 to 128 letters, digits, dots, underscores, slashes, colons or hyphens")
		}
		// Ollama cloud models use a "cloud" tag or a "-cloud" tag suffix
		// (gpt-oss:120b-cloud); a local name such as wordcloud-7b stays allowed.
		if lower := strings.ToLower(c.model); strings.HasSuffix(lower, ":cloud") || strings.HasSuffix(lower, "-cloud") {
			return c, errors.New("OLLAMA_MODEL must be a downloaded local model; cloud model names are not supported")
		}
	}
	if c.checkModel && c.modelURL == "" {
		return c, errors.New("check --model requires OLLAMA_URL; leave it empty to use checklist mode")
	}
	return c, nil
}

var modelNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,127}$`)

func addressHost(address string, allowWildcard bool) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", err
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 || (!allowWildcard && host == "") ||
		strings.ContainsAny(host, " /\\@?#\r\n\t") {
		return "", errors.New("invalid address")
	}
	return host, nil
}

func validateModelURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") ||
		u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(u.Path != "" && u.Path != "/") || u.RawPath != "" || u.Opaque != "" || strings.Contains(raw, "#") || strings.HasSuffix(u.Host, ":") {
		return errors.New("OLLAMA_URL must be an http(s) server base URL without credentials, path, query or fragment")
	}
	if u.Port() != "" {
		n, err := strconv.Atoi(u.Port())
		if err != nil || n < 1 || n > 65535 {
			return errors.New("OLLAMA_URL has an invalid port")
		}
	}
	return nil
}

func (c runtimeConfig) validateFiles() error {
	if c.command == "worker" {
		return nil
	}
	for _, name := range []string{"index.html", "app.js", "style.css"} {
		info, err := os.Stat(filepath.Join(c.webDir, name))
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("WEB_DIR is missing %s; point it at the built web/dist directory", name)
		}
	}
	for _, name := range []string{"processor.csv", "bank.csv"} {
		info, err := os.Stat(filepath.Join(c.sampleDir, name))
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("SAMPLE_DIR is missing %s; point it at the repository samples directory", name)
		}
	}
	if c.databaseURL == "" {
		info, err := os.Stat(c.statePath)
		if err == nil && !info.Mode().IsRegular() {
			return errors.New("STATE_PATH must name a state file, not a directory")
		}
		if err != nil && !os.IsNotExist(err) {
			return errors.New("STATE_PATH cannot be inspected; check directory permissions")
		}
		web, err := resolveExistingPath(c.webDir)
		if err != nil {
			return errors.New("WEB_DIR could not be resolved")
		}
		state, err := resolveExistingPath(c.statePath)
		if err != nil {
			return errors.New("STATE_PATH could not be resolved")
		}
		relative, err := filepath.Rel(web, state)
		if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return errors.New("STATE_PATH must be outside WEB_DIR so evidence is not served as a public asset")
		}
	}
	return nil
}

func (c runtimeConfig) describe(w io.Writer) {
	storage, investigator, auth := "local-file", "rules (checklist)", "off (loopback only)"
	if c.databaseURL != "" {
		storage = "postgres (connection not checked)"
	}
	if c.modelURL != "" {
		investigator = "ollama:" + c.model + " (inference not checked)"
	}
	if c.token != "" {
		auth = "workspace token configured (value hidden)"
	}
	fmt.Fprintf(w, "Configuration valid. Offline check; no services contacted or workspace created.\nMode: %s\nStorage: %s\nInvestigator: %s\nAuthentication: %s\nRedis configured: %t\nKafka configured: %t\n",
		c.command, storage, investigator, auth, c.redisURL != "", c.brokers != "")
	if c.command == "serve" {
		fmt.Fprintln(w, "UI assets and synthetic sample files: present")
	}
}

// Resolve symlinks/junctions in existing ancestors without creating future
// state directories. A dangling symlink fails closed rather than being guessed.
func resolveExistingPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return real, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	if info, statErr := os.Lstat(absolute); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("dangling path link")
	}
	parent := filepath.Dir(absolute)
	if parent == absolute {
		return "", err
	}
	resolved, err := resolveExistingPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(absolute)), nil
}
