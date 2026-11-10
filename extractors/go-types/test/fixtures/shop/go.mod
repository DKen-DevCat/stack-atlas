module example.com/shop

go 1.22

require (
	example.com/local v0.0.0
	github.com/ext/unknown v1.0.0
	github.com/vend/lib v1.0.0
)

replace example.com/local => ./x
