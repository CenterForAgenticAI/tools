package session

var States = []string{"idle", "working", "blocked", "not-running"}

func DecideTransition(from, to string) bool {
	return from != "not-running"
}
