VERSION ?= v1.1.0
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all web build build-linux test race fuzz vet clean docker

all: web build

web:
	cd web && pnpm install --frozen-lockfile && pnpm run build

build:
	go build -trimpath -ldflags="$(LDFLAGS)" -o cosd ./cmd/cosd

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="$(LDFLAGS)" -o cosd-linux-amd64 ./cmd/cosd

test:
	go vet ./...
	go test -v ./...

race:
	CGO_ENABLED=1 go test -race -v ./...

fuzz:
	go test -fuzz=FuzzNormalizeObjectKey -fuzztime=5s ./internal/store
	go test -fuzz=FuzzPrefixUpperBound -fuzztime=5s ./internal/store
	go test -fuzz=FuzzS3PercentEncode -fuzztime=5s ./internal/auth

docker:
	docker build --build-arg VERSION=$(VERSION) -f deploy/Dockerfile -t nanocos:$(VERSION) .

clean:
	rm -f cosd cosd.exe cosd.exe~ cosd-linux-amd64
