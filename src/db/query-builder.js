/**
 * Lightweight, zero-dependency SQL Query Builder helper for dynamic queries.
 * Eliminates "WHERE 1=1" anti-patterns and safely manages parameterized filters.
 */
export class DynamicQueryBuilder {
  constructor(baseSelect) {
    if (!baseSelect || typeof baseSelect !== "string") {
      throw new Error("baseSelect query is required");
    }
    this.baseSelect = baseSelect.trim();
    this.conditions = [];
    this.params = [];
    this.orderByClause = "";
    this.limitVal = null;
    this.offsetVal = null;
  }

  /**
   * Unconditionally add a WHERE condition fragment and its parameters.
   */
  where(condition, ...params) {
    if (condition && condition.trim()) {
      this.conditions.push(condition.trim());
      if (params.length > 0) {
        this.params.push(...params);
      }
    }
    return this;
  }

  /**
   * Conditionally add a WHERE condition fragment only if predicate is truthy.
   */
  whereIf(shouldApply, condition, ...params) {
    if (shouldApply) {
      this.where(condition, ...params);
    }
    return this;
  }

  /**
   * Set ORDER BY clause.
   */
  orderBy(clause) {
    if (clause && clause.trim()) {
      this.orderByClause = `ORDER BY ${clause.trim()}`;
    }
    return this;
  }

  /**
   * Set parameterized LIMIT.
   */
  limit(count) {
    if (count !== undefined && count !== null) {
      this.limitVal = Number(count);
    }
    return this;
  }

  /**
   * Set parameterized OFFSET.
   */
  offset(count) {
    if (count !== undefined && count !== null) {
      this.offsetVal = Number(count);
    }
    return this;
  }

  /**
   * Compiles the SQL string and parameter array.
   */
  build() {
    const parts = [this.baseSelect];

    if (this.conditions.length > 0) {
      parts.push(`WHERE ${this.conditions.join(" AND ")}`);
    }

    if (this.orderByClause) {
      parts.push(this.orderByClause);
    }

    const queryParams = [...this.params];

    if (this.limitVal !== null) {
      parts.push("LIMIT ?");
      queryParams.push(this.limitVal);
    }

    if (this.offsetVal !== null) {
      parts.push("OFFSET ?");
      queryParams.push(this.offsetVal);
    }

    return {
      sql: parts.join(" "),
      params: queryParams,
    };
  }
}
