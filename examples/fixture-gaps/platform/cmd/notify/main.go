// Command notify は EventBridge Scheduler から毎日起動される通知 Lambda。
package main

import (
	"fmt"
)

func main() {
	fmt.Println("notify: send daily summary")
}
