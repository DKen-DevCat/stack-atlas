// Package h は gin と chi のハンドラ。
package h

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/go-chi/chi/v5"
)

// Item はリクエストと応答の struct。
type Item struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Auth は Authorization が無ければ 401（gin の middleware）。
func Auth() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	}
}

// GetItem は 1 件を返す。
func GetItem(c *gin.Context) {
	id := c.Param("id")
	c.JSON(http.StatusOK, Item{ID: id})
}

// CreateItem は body を受けて返す。
func CreateItem(c *gin.Context) {
	var in Item
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, nil)
		return
	}
	c.JSON(http.StatusCreated, in)
}

// Thing は chi の net/http ハンドラ。
func Thing(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	_, _ = w.Write([]byte(id))
}
