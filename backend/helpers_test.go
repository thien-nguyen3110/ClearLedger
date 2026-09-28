package main

import (
	"io"
	"net/http"
	"net/http/httptest"
)

// localRequest is an httptest request addressed to the loopback API, as the
// browser sends it. httptest.NewRequest defaults Host to example.com, which the
// tokenless API rejects as a possible DNS-rebinding request.
func localRequest(method, target string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, target, body)
	r.Host = "127.0.0.1:18080"
	return r
}
