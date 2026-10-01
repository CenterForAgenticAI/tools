package main

import (
	"fmt"
	"example.com/transitions/go/session"
)

func main() {
	for _, from := range session.States {
		for _, to := range session.States {
			fmt.Printf("%s->%s %t\n", from, to, session.DecideTransition(from, to))
		}
	}
}
